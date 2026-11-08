/**
 * dsh-livis-source — Cordis plugin registering the `livis` SourceKind and
 * running the Livis relay for that Source.
 *
 * Inbound `send_message` frames become Triggers (source `livis`, thread
 * `livis:<from_node_id>`, direct human message). Engine acknowledgements are
 * consumed locally; the engine's single reply is delivered as the one Livis
 * final result for that job.
 *
 * SPDX-License-Identifier: MIT
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { createLivisRelay } from './src/relay.js'

/** Cordis plugin name; the profile entry imports this package by module name. */
export const name = 'dsh-livis-source'
/** The orchestrator service exposes `sources.register()` and `context()`. */
export const inject = ['orchestrator']

/**
 * Cordis plugin configuration. The Source itself is configured per instance in
 * the orchestrator Settings (see `LivisConfigSchema`); this plugin-level schema
 * is intentionally empty.
 */
export const Config = s.object({})

/** Base directory for the protocol client state and the plugin's job journal. */
const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'state', 'livis', 'livis-source')

/**
 * Configuration of the `livis` Source instance, stored by the orchestrator and
 * editable in Settings. `.strict()` rejects unknown keys and unsafe values, and
 * every field has a default so a freshly registered Source is valid.
 */
export const LivisConfigSchema = z.object({
  /** Whether the Source participates in routing. */
  enabled: z.boolean().default(true),
  /** Holds protocol credentials/cache (`client/`) and the job journal (`jobs.json`). */
  stateDir: z.string().trim().min(1).default(DEFAULT_STATE_DIR),
  /** Text sent as the single final result when an ignored job times out. */
  fallbackText: z.string().trim().min(1).default('抱歉，这条消息没有产生可执行的任务。'),
  /** How long a pending job may wait before the fallback result is sent, in milliseconds. */
  pendingTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
  /** `from_node_id` of the single Livis user bound to this deployment; empty means the Policy decides. */
  allowedActor: z.string().trim().default(''),
}).strict()

/** Configuration inferred from the schema (documentation aid; this package is plain JavaScript). */
/** @typedef {z.infer<typeof LivisConfigSchema>} LivisConfig */

const localized = (zh, en) => ({ zh, en })

/** Environment variable used by the P3 integration harness to relocate plugin state. */
export const STATE_DIR_ENV = 'DSH_LIVIS_STATE_DIR'

/**
 * Build the `livis` SourceKind. `getRelay` returns the active relay runtime (or
 * null before boot); `channel.send` must consume acknowledgements locally and
 * deliver exactly one final result through the relay.
 *
 * @param {() => {handleOutbound: Function} | null} getRelay
 * @returns {object} SourceKind descriptor consumed by dsh-superagent (`kind`,
 *   `health`, `scope`, `channel`, `policy`). Typed loosely because the host
 *   package is not a dependency of this plugin.
 */
export function createLivisSourceKind(getRelay) {
  return {
    kind: 'livis',
    title: localized('Livis', 'Livis'),
    description: localized(
      '接收理想 AI 眼镜的语音消息并按 strict IM 语义路由；每个 job 只回一条终稿。',
      'Receives voice messages from Livis glasses and routes them with strict IM semantics; exactly one final result per job.',
    ),
    schema: LivisConfigSchema,
    fields: [
      {
        key: 'enabled',
        type: 'switch',
        label: localized('启用 Livis 源', 'Enable the Livis Source'),
        hint: localized('关闭后本 Source 不监听、不回复；不影响其他 Source。', 'When off, this Source listens to nothing and replies to nothing; other Sources are unaffected.'),
      },
      {
        key: 'stateDir',
        type: 'text',
        label: localized('状态目录', 'State directory'),
        hint: localized('保存设备凭据、完成结果缓存与 job 日志（文件权限 0600）。', 'Stores device credentials, the completed-result cache and the job journal (files mode 0600).'),
        advanced: true,
      },
      {
        key: 'fallbackText',
        type: 'text',
        label: localized('兜底文案', 'Fallback text'),
        hint: localized('被忽略的消息在等待超时后收到这一条结果。', 'An ignored message receives this single result after the pending timeout.'),
      },
      {
        key: 'pendingTimeoutMs',
        type: 'number',
        min: 1000,
        max: 600000,
        label: localized('等待超时（毫秒）', 'Pending timeout (ms)'),
        hint: localized('从收到消息到发出兜底结果的最长等待时间。', 'Longest wait from receipt to the fallback result.'),
        advanced: true,
      },
      {
        key: 'allowedActor',
        type: 'text',
        label: localized('绑定的用户 node id', 'Bound actor node id'),
        hint: localized('只有这个 Livis 用户能发起工作；留空则由 Policy 的允许名单决定。', 'Only this Livis user may originate work; empty leaves admission to the Policy allow-list.'),
      },
    ],
    /** Health entry owned by this kind; only this plugin may report it. */
    health: ['livis'],
    /** Strict IM scope: listen to every Livis trigger while enabled. */
    scope(_input, config) {
      return config.enabled ? { listened: true, observed: false } : { listened: false, reason: 'source_disabled' }
    },
    /** Outbound adapter: acknowledgements are local, replies become one final result. */
    channel: {
      allowed(_address, config) {
        return config.enabled
      },
      async send(_host, message) {
        const relay = getRelay()
        if (!relay) return 'gone'
        return relay.handleOutbound(message)
      },
      link(_address, _links) {
        return { url: '', label: localized('Livis', 'Livis') }
      },
    },
    /** The journal keeps the message id; no thread history is readable yet. */
    threadContext: {
      messageId(trigger) {
        const id = trigger.meta?.messageId
        return typeof id === 'string' && id ? id : trigger.id
      },
      async read() {
        return { messages: [], body: {} }
      },
    },
    /** No searchable index yet; a full thread key can still be looked up directly. */
    find(query) {
      const thread = query.trim()
      return { threads: thread.startsWith('livis:') ? [thread] : [], terms: [] }
    },
    /** Reply linkage is the Livis job id. */
    repliesTo(trigger) {
      const reply = trigger.meta?.replyTo
      return typeof reply === 'string' && reply ? reply : undefined
    },
    /** Policy part: the bound Livis actor is the only sender who may originate work. */
    policy: {
      schema: z.object({
        allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
          .refine(actors => new Set(actors.map(actor => actor.id)).size === actors.length, 'Duplicate actor ids')
          .default([]),
      }).strict(),
      fields: [
        {
          key: 'allowed',
          type: 'rows',
          label: localized('能发起工作的 Livis 用户', 'Livis users who may originate work'),
          hint: localized('名单外的用户消息不会被接收。', 'Messages from users outside this list are not admitted.'),
          columns: [
            { key: 'id', type: 'text', label: localized('用户 node id', 'User node id') },
            { key: 'name', type: 'text', label: localized('名字', 'Name'), optional: true },
          ],
        },
      ],
      explicit: localized('绑定的用户直接对眼镜说话，总是明确的请求。', 'The bound user speaking to the glasses always makes an explicit request.'),
      unnamed: { person: localized('Livis 用户', 'Livis user'), bot: localized('Livis 机器人', 'Livis bot') },
    },
    /** Expose the message's Livis sender to the execution environment. */
    environment: {
      variables: [
        { key: 'DSH_LIVIS_ACTOR', description: localized('本条消息的 Livis 发送者 node id；没有时为绑定的用户', 'The Livis sender node id of this message; the bound user when absent') },
      ],
      values({ config, trigger }) {
        const from = trigger?.meta?.from_node_id
        const actor = typeof from === 'string' && from ? from : config.allowedActor
        return { DSH_LIVIS_ACTOR: actor }
      },
    },
  }
}

/** The active relay, set by `apply` after the orchestrator is ready. */
let activeRelay = null

/** The registered SourceKind identity (P3 ingests through `context(livisKind).receive`). */
export const livisKind = createLivisSourceKind(() => activeRelay)

/**
 * Registers the SourceKind exactly once while the plugin is mounted, logs the
 * lifecycle event for verification, then boots the relay for the configured
 * Source. A relay failure is reported through the kind's health entry and never
 * crashes the orchestrator.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.orchestrator.sources.register(livisKind)
    ctx.logger.info('dsh-livis-source: registered SourceKind "livis"')
    // The orchestrator's console exporter is level-filtered, so also emit the
    // lifecycle marker to stderr for boot-log verification.
    console.error('[dsh-livis-source] registered SourceKind "livis"')
    return () => {
      ctx.logger.info('dsh-livis-source: unregistered SourceKind "livis"')
      console.error('[dsh-livis-source] unregistered SourceKind "livis"')
      dispose()
    }
  }, 'livis: source kind')

  ctx.effect(() => {
    const source = ctx.orchestrator.context(livisKind)
    let disposed = false
    let relay = null
    const boot = (async () => {
      await source.ready
      if (disposed) return
      const config = source.config('livis')
      if (!config || config.enabled === false) {
        source.report('livis', { state: 'paused', detail: 'The Livis Source is disabled', at: new Date().toISOString() })
        return
      }
      const stateDir = process.env[STATE_DIR_ENV] || config.stateDir
      const candidate = createLivisRelay({ source, config, stateDir, logger: ctx.logger })
      if (disposed) {
        await candidate.stop().catch(() => {})
        return
      }
      relay = candidate
      activeRelay = candidate
      try {
        await candidate.start()
      } catch (error) {
        console.error('[dsh-livis-source] relay boot failed:', error?.code ?? '', error?.message ?? error)
      }
    })().catch((error) => {
      console.error('[dsh-livis-source] relay setup failed:', error?.code ?? '', error?.message ?? error)
      try {
        source.report('livis', { state: 'error', detail: String(error?.message ?? error).slice(0, 200), at: new Date().toISOString() })
      } catch {
        // The Source may already be torn down.
      }
    })

    return async () => {
      disposed = true
      if (relay) {
        if (activeRelay === relay) activeRelay = null
        await relay.stop().catch(() => {})
      }
      await boot.catch(() => {})
    }
  }, 'livis: relay')
}
