/**
 * Livis relay runtime: protocol client lifecycle, inbound task -> Trigger
 * ingestion, and the channel state machine that turns engine acknowledgements
 * and replies into exactly one Livis final result per job.
 *
 * State machine per job:
 *   pending  -- engine acknowledgement --> accepted  -- reply --> final
 *   pending  -- pendingTimeoutMs --------> final (fallback text)
 *   any      -- cancel_chat -------------> canceled
 *
 * The acknowledgement OutboundMessage is consumed here and is never written to
 * the relay. The protocol client's own automatic `ack_send_message` frame is a
 * transport-level acknowledgement and is independent of this state machine.
 */
import { join } from 'node:path'
import { createLivisClient } from 'dsh-livis-protocol'
import { createJobStore } from './jobs.js'

const RETRYABLE = new Set([
  'LIVIS_RESULT_NOT_ACKED',
  'LIVIS_NOT_CONNECTED',
  'LIVIS_DISCONNECTED',
  'LIVIS_CONNECTED_FAILED',
  'LIVIS_CONNECTION_FAILED',
  'LIVIS_CONNECT_TIMEOUT',
  'LIVIS_STOPPED',
])

const iso = () => new Date().toISOString()

// The Livis glasses App prepends an official wake word to the spoken request.
// It is not part of the user's question, so it is stripped at the Source
// boundary before the Trigger is built. The original text is kept as rawText.
const WAKE_SEPARATOR = '[\\s\\p{P}\\p{Z}\\u200B-\\u200D\\uFEFF\\u2060]*'
const WAKE_WORD_PATTERN = new RegExp(
  `^${WAKE_SEPARATOR}(?:` +
    `让${WAKE_SEPARATOR}我${WAKE_SEPARATOR}的${WAKE_SEPARATOR}个${WAKE_SEPARATOR}人${WAKE_SEPARATOR}(?:agent|终端)` +
    `|让${WAKE_SEPARATOR}我${WAKE_SEPARATOR}的${WAKE_SEPARATOR}open${WAKE_SEPARATOR}claw` +
    `|让${WAKE_SEPARATOR}我${WAKE_SEPARATOR}的${WAKE_SEPARATOR}小${WAKE_SEPARATOR}龙${WAKE_SEPARATOR}虾` +
  `)${WAKE_SEPARATOR}`,
  'iu',
)

/**
 * Strip one leading official Livis wake word from inbound content.
 * Case-insensitive and tolerant of spaces, punctuation, and zero-width
 * characters. Non-wake content is returned unchanged. If only a wake word was
 * spoken, the original text is kept so an empty question is never emitted.
 *
 * @param {unknown} value
 * @returns {{text: string, rawText: string, stripped: boolean, wakeWordOnly: boolean}}
 */
export function stripWakeWord(value) {
  const rawText = String(value ?? '')
  const match = WAKE_WORD_PATTERN.exec(rawText)
  if (!match) return { text: rawText, rawText, stripped: false, wakeWordOnly: false }
  const text = rawText
    .slice(match[0].length)
    .replace(/^[\s\p{P}\p{Z}\u200B-\u200D\uFEFF\u2060]+/u, '')
    .trim()
  if (!text) return { text: rawText, rawText, stripped: true, wakeWordOnly: true }
  return { text, rawText, stripped: true, wakeWordOnly: false }
}

// Spoken questions often arrive with a lead-in such as "我问他" / "我问你"
// (the App's ASR may also turn "你" into "他"). It is a speech frame, not the
// question itself, so it is stripped before the Trigger is built. The full
// original remains in rawText.
const VOICE_LEAD_IN_PATTERN = new RegExp(
  `^${WAKE_SEPARATOR}我${WAKE_SEPARATOR}(?:问|跟|对)${WAKE_SEPARATOR}(?:你|您|他|她|它)${WAKE_SEPARATOR}(?:说|讲|道)?${WAKE_SEPARATOR}`,
  'iu',
)

/**
 * Strip one leading spoken lead-in ("我问他", "我问你", ...), keeping the
 * original text in rawText and refusing to produce an empty question.
 * @param {unknown} value
 * @returns {{text: string, rawText: string, stripped: boolean}}
 */
export function stripVoiceLeadIn(value) {
  const rawText = String(value ?? '')
  const match = VOICE_LEAD_IN_PATTERN.exec(rawText)
  if (!match) return { text: rawText, rawText, stripped: false }
  const text = rawText
    .slice(match[0].length)
    .replace(/^[\s\p{P}\p{Z}\u200B-\u200D\uFEFF\u2060]+/u, '')
    .trim()
  if (!text) return { text: rawText, rawText, stripped: false }
  return { text, rawText, stripped: true }
}

/** Apply wake-word and spoken lead-in normalization in one pass. */
export function normalizeInbound(value) {
  const wake = stripWakeWord(value)
  const lead = stripVoiceLeadIn(wake.text)
  return {
    text: lead.text,
    rawText: wake.rawText,
    stripped: wake.stripped,
    wakeWordOnly: wake.wakeWordOnly,
    leadInStripped: lead.stripped,
  }
}

/**
 * @param {{
 *   source: {report: Function, receive: Function, config: Function},
 *   config: {enabled: boolean, stateDir: string, fallbackText: string, pendingTimeoutMs: number, allowedActor: string},
 *   stateDir?: string,
 *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
 *   clientOptions?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   silent?: boolean,
 * }} options
 */
export class LivisRelay {
  #source
  #config
  #stateDir
  #clientOptions
  #env
  #logger
  #silent
  #store = null
  #client = null
  #timers = new Map()
  #unsubscribers = []
  #stopped = false
  #started = false
  #lastConnectedAt = null

  constructor({ source, config, stateDir, logger = null, clientOptions = {}, env = process.env, silent = false }) {
    this.#source = source
    this.#config = config
    this.#stateDir = stateDir || config.stateDir
    this.#clientOptions = clientOptions
    this.#env = env
    this.#logger = logger
    this.#silent = silent
  }

  /** @returns {Promise<void>} */
  async start() {
    if (this.#started) return
    this.#started = true
    this.#store = createJobStore({ stateDir: this.#stateDir, logger: this.#logger })
    await this.#store.load()

    const clientOptions = this.#clientConfig()
    this.#report('starting', 'Livis relay starting')
    const client = createLivisClient(clientOptions)
    this.#client = client
    this.#unsubscribers.push(
      client.on('connected', (event) => {
        this.#lastConnectedAt = event?.at ?? Date.now()
        this.#report('ready', `Livis relay connected as ${event?.agentId ?? 'agent'}`)
        this.#say(`connected as ${event?.agentId ?? 'agent'}`)
      }),
      client.on('disconnected', (event) => {
        this.#report('starting', `Livis relay disconnected; reconnecting (${event?.reason ?? event?.code ?? 'transport'})`)
      }),
      client.on('message', (task) => {
        void this.#admit(task).catch((error) => this.#say(`inbound handling failed: ${error?.message ?? error}`))
      }),
      client.on('cancel', (event) => {
        void this.#cancel(event?.jobId).catch((error) => this.#say(`cancel handling failed: ${error?.message ?? error}`))
      }),
      client.on('error', (event) => {
        const code = event?.code ?? 'LIVIS_ERROR'
        this.#report('error', `${code}: ${event?.message ?? 'relay error'}`, code)
      }),
    )

    try {
      await client.start()
      this.#say(`relay ready; agent=${client.getIdentity().agentId ?? 'unknown'}`)
    } catch (error) {
      const code = error?.code ?? 'LIVIS_ERROR'
      if (code === 'LIVIS_AUTH_REQUIRED') {
        this.#report('paused', 'Livis authorization required: no refresh token is provisioned')
        this.#say('relay paused: authorization required (no refresh token)')
      } else {
        this.#report('error', `${code}: ${error?.message ?? 'relay start failed'}`, code)
        this.#say(`relay start failed: ${code}: ${error?.message ?? error}`)
      }
    }
    // Recover pending fallbacks from a previous process. Accepted jobs wait
    // for their engine reply; completed jobs never replay a second final.
    for (const job of this.#store.list()) {
      if (job.status === 'pending') this.#scheduleFallback(job)
    }
  }

  async stop() {
    if (this.#stopped) return
    this.#stopped = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // Already detached.
      }
    }
    if (this.#client) await this.#client.stop().catch(() => {})
    this.#report('paused', 'Livis relay stopped')
  }

  /** @param {string} jobId */
  job(jobId) {
    return this.#store?.get(jobId)
  }

  /** Deliver one engine OutboundMessage. @returns {Promise<'sent'|'gone'>} */
  async handleOutbound(message) {
    const jobId = String(message?.channel?.address?.jobId ?? '')
    if (!jobId) return 'gone'
    switch (message?.kind) {
      case 'acknowledgement':
        return this.#accept(jobId)
      case 'reply':
        return this.#reply(jobId, String(message?.text ?? ''))
      case 'notice':
        return 'gone'
      default:
        return 'gone'
    }
  }

  // ---------------------------------------------------------------- inbound

  /** @param {any} task protocol TaskEnvelope */
  async #admit(task) {
    const jobId = String(task?.jobId ?? '')
    const fromNodeId = String(task?.fromNodeId ?? '')
    const normalized = normalizeInbound(task?.content)
    const text = normalized.text
    if (!jobId || !fromNodeId || !text.trim()) {
      this.#say(`dropped malformed inbound job ${jobId || '(none)'}`)
      return 'filtered'
    }
    const existing = this.#store.get(jobId)
    if (existing) {
      this.#say(`duplicate inbound job ${jobId} ignored (status ${existing.status})`)
      return 'duplicate'
    }
    const bound = typeof this.#config.allowedActor === 'string' ? this.#config.allowedActor.trim() : ''
    if (bound && fromNodeId !== bound) {
      this.#say(`inbound job ${jobId} from an unbound actor ignored`)
      return 'filtered'
    }

    const trigger = this.#trigger(task, normalized)
    const job = {
      jobId,
      msgId: String(task.msgId ?? ''),
      fromNodeId,
      fromNodeType: String(task.fromNodeType ?? ''),
      thread: `livis:${fromNodeId}`,
      triggerId: trigger.id,
      text,
      rawText: normalized.rawText,
      wakeStripped: normalized.stripped,
      wakeWordOnly: normalized.wakeWordOnly,
      leadInStripped: normalized.leadInStripped,
      status: 'pending',
      receivedAt: iso(),
    }
    // Persist before ingestion so a crash cannot turn a delivered job into a
    // second engine trigger after restart.
    await this.#store.put(job)
    this.#scheduleFallback(job)

    let result
    try {
      result = await this.#source.receive(trigger)
    } catch (error) {
      // The orchestrator failed to ingest; leave the job pending so the single
      // fallback still answers the user, and surface the failure in logs.
      this.#say(`source.receive failed for job ${jobId}: ${error?.message ?? error}`)
      return 'filtered'
    }
    this.#say(`inbound job ${jobId} -> receive ${result}`)
    return result
  }

  /** @param {any} task @param {{text:string,rawText:string,stripped:boolean,wakeWordOnly:boolean}} normalized */
  #trigger(task, normalized = stripWakeWord(task?.content)) {
    const fromNodeId = String(task.fromNodeId)
    const jobId = String(task.jobId)
    const msgId = String(task.msgId)
    return {
      id: `livis:${jobId}`,
      source: 'livis',
      threads: [{ source: 'livis', id: fromNodeId }],
      actor: { source: 'livis', id: fromNodeId },
      human: true,
      addressed: 'direct',
      at: iso(),
      text: normalized.text,
      channel: {
        source: 'livis',
        thread: `livis:${fromNodeId}`,
        address: {
          jobId,
          msgId,
          fromNodeId,
          nodeType: String(task.fromNodeType ?? 'personl-device'),
        },
      },
      meta: {
        jobId,
        msgId,
        messageId: msgId,
        replyTo: jobId,
        from_node_id: fromNodeId,
        fromNodeType: String(task.fromNodeType ?? ''),
        nodeType: 'personl-device',
        rawText: normalized.rawText,
        wakeWordStripped: normalized.stripped,
        wakeWordOnly: normalized.wakeWordOnly,
        leadInStripped: normalized.leadInStripped,
      },
    }
  }

  /** @param {string} jobId */
  async #cancel(jobId) {
    const job = this.#store.get(jobId)
    if (!job) return
    this.#clearTimer(jobId)
    if (job.status === 'final' || job.status === 'canceled') return
    job.status = 'canceled'
    job.canceledAt = iso()
    await this.#store.put(job)
    this.#say(`job ${jobId} canceled`)
  }

  // --------------------------------------------------------------- outbound

  /** @param {string} jobId */
  async #accept(jobId) {
    const job = this.#store.get(jobId)
    if (!job) return 'gone'
    if (job.status === 'accepted') return 'sent'
    if (job.status !== 'pending') return 'gone'
    this.#clearTimer(jobId)
    job.status = 'accepted'
    job.acceptedAt = iso()
    await this.#store.put(job)
    // The engine acknowledgement is consumed locally; it must never reach the
    // Livis relay. The protocol client's auto-ack frame is separate.
    this.#say(`job ${jobId} accepted (engine acknowledgement consumed locally)`)
    return 'sent'
  }

  /** @param {string} jobId @param {string} text */
  async #reply(jobId, text) {
    const job = this.#store.get(jobId)
    if (!job) return 'gone'
    if (job.status === 'final' || job.status === 'canceled' || job.status === 'failed') return 'gone'
    if (job.finalSending) return 'sent'
    this.#clearTimer(jobId)
    job.finalSending = true
    try {
      await this.#client.sendResult(jobId, { text })
      job.status = 'final'
      job.resultKind = 'reply'
      job.finalText = text
      job.resultDeliveries = (job.resultDeliveries ?? 0) + 1
      job.finalAt = iso()
      delete job.finalSending
      await this.#store.put(job)
      this.#say(`job ${jobId} final reply delivered`)
      return 'sent'
    } catch (error) {
      delete job.finalSending
      const code = error?.code ?? 'LIVIS_ERROR'
      if (code === 'LIVIS_JOB_CANCELED') {
        job.status = 'canceled'
        job.canceledAt = iso()
        await this.#store.put(job)
        return 'gone'
      }
      if (RETRYABLE.has(code)) {
        // Let the orchestrator outbox retry; the protocol persists the result
        // before sending, so a retry never creates a second logical final.
        this.#report('starting', `Livis result pending: ${code}`)
        throw error
      }
      this.#report('error', `${code}: ${error?.message ?? 'result delivery failed'}`, code)
      return 'gone'
    }
  }

  // --------------------------------------------------------------- fallback

  /** @param {any} job */
  #scheduleFallback(job) {
    if (!job || job.status !== 'pending' || this.#stopped) return
    this.#clearTimer(job.jobId)
    const due = Date.parse(job.receivedAt) + this.#config.pendingTimeoutMs - Date.now()
    const timer = setTimeout(() => {
      this.#timers.delete(job.jobId)
      void this.#sendFallback(job.jobId)
    }, Math.max(0, Number.isFinite(due) ? due : 0))
    timer.unref?.()
    this.#timers.set(job.jobId, timer)
  }

  /** @param {string} jobId */
  async #sendFallback(jobId) {
    if (this.#stopped) return
    const job = this.#store.get(jobId)
    if (!job || job.status !== 'pending') return
    try {
      await this.#client.sendResult(jobId, { text: this.#config.fallbackText })
      job.status = 'final'
      job.resultKind = 'fallback'
      job.finalText = this.#config.fallbackText
      job.resultDeliveries = (job.resultDeliveries ?? 0) + 1
      job.finalAt = iso()
      await this.#store.put(job)
      this.#say(`job ${jobId} fallback result delivered`)
    } catch (error) {
      const code = error?.code ?? 'LIVIS_ERROR'
      if (code === 'LIVIS_JOB_CANCELED') {
        job.status = 'canceled'
        job.canceledAt = iso()
        await this.#store.put(job)
        return
      }
      job.fallbackAttempts = (job.fallbackAttempts ?? 0) + 1
      if (job.fallbackAttempts >= 5) {
        job.status = 'failed'
        job.failedAt = iso()
        job.failure = code
        await this.#store.put(job)
        this.#report('error', `${code}: fallback delivery failed for job ${jobId}`, code)
        return
      }
      await this.#store.put(job)
      this.#report('starting', `Livis fallback pending: ${code}`)
      const timer = setTimeout(() => {
        this.#timers.delete(jobId)
        void this.#sendFallback(jobId)
      }, 3000)
      timer.unref?.()
      this.#timers.set(jobId, timer)
    }
  }

  // ------------------------------------------------------------------ utils

  #clientConfig() {
    const options = {
      stateDir: join(this.#stateDir, 'client'),
      logger: this.#protocolLogger(),
      logLevel: this.#silent ? 'error' : 'warn',
      autoAck: true,
      // Exactly one logical final per job is the plugin's contract. A duplicate
      // delivery after restart must not replay a second final.
      replayCompletedResults: false,
      ...this.#clientOptions,
    }
    const env = this.#env ?? {}
    if (env.DSH_LIVIS_WS_URL) options.websocketUrl = env.DSH_LIVIS_WS_URL
    if (env.DSH_LIVIS_HTTP_URL) options.httpUrl = env.DSH_LIVIS_HTTP_URL
    if (env.DSH_LIVIS_IDAAS_ENDPOINT) options.idaasEndpoint = env.DSH_LIVIS_IDAAS_ENDPOINT
    if (env.DSH_LIVIS_REFRESH_TOKEN) options.refreshToken = env.DSH_LIVIS_REFRESH_TOKEN
    return options
  }

  #protocolLogger() {
    if (this.#silent) return { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
    return {
      debug() {},
      info() {},
      warn: (...args) => console.error('[dsh-livis-source] protocol warn:', ...args),
      error: (...args) => console.error('[dsh-livis-source] protocol error:', ...args),
      child() {
        return this
      },
    }
  }

  #report(state, detail, code) {
    try {
      this.#source.report?.('livis', { state, detail, at: iso(), ...(code ? { code } : {}) })
    } catch {
      // Health reporting must never break relay handling.
    }
  }

  #clearTimer(jobId) {
    const timer = this.#timers.get(jobId)
    if (timer) clearTimeout(timer)
    this.#timers.delete(jobId)
  }

  #say(text) {
    if (this.#silent) return
    console.error(`[dsh-livis-source] ${text}`)
  }
}

export function createLivisRelay(options) {
  return new LivisRelay(options)
}
