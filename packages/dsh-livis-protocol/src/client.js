/**
 * Livis relay client.
 *
 * Lifecycle: stopped -> connecting -> handshaking -> connected, with automatic
 * reconnect (exponential backoff + jitter) and token refresh on
 * `token_expiring`.
 *
 * The client owns:
 *  - IDaaS access/refresh token acquisition + rotation (via `auth`)
 *  - the WSS connection, connect frame, heartbeat, reconnect loop
 *  - inbound parsing, automatic ack_send_message / ack_cancel_chat
 *  - send_result delivery with ack tracking (up to 4 attempts), result
 *    persistence before delivery, and idempotent replay for duplicate jobs
 *  - file uploads
 *  - redacted diagnostics via `health()`
 */

import { CLIENT_PHASES, RELAY_POLICY } from './constants.js';
import { resolveConfig } from './config.js';
import { createStateStore } from './state.js';
import { createDeviceAuth } from './auth.js';
import {
  connectEnvelope,
  envelope,
  parseInbound,
  resultData,
  uuid,
  withProtocolVersion,
} from './protocol.js';
import { uploadFiles as uploadFilesFromDisk } from './upload.js';
import {
  LivisAuthError,
  LivisAuthRequiredError,
  LivisConfigError,
  LivisConnectTimeoutError,
  LivisConnectionError,
  LivisDisconnectedError,
  LivisError,
  LivisNotConnectedError,
  LivisResultNotAckedError,
  LivisStoppedError,
  LivisTimeoutError,
} from './errors.js';

const MAX_TRANSITIONS = 50;

function errorPayload(error) {
  return {
    message: error?.message ?? String(error),
    code: typeof error?.code === 'string' ? error.code : 'LIVIS_ERROR',
    retryable: error?.retryable === true,
  };
}

export class LivisClient {
  #config;
  #store;
  #auth;
  #logger;
  #redactor;

  #agentId = null;
  #deviceId = null;
  #initialized = false;
  #initPromise = null;

  #phase = 'stopped';
  #started = false;
  #stopping = false;

  #socket = null;
  #wsOpen = false;
  #handshakeAccepted = false;

  #startPromise = null;
  #startResolve = null;
  #startReject = null;
  #startDeadlineTimer = null;

  #heartbeatTimer = null;
  #heartbeatCount = 0;
  #lastHeartbeatAt = null;

  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #reconnectCount = 0;

  /** @type {Map<string, {promise: Promise<boolean>, cancel: Function}>} */
  #pendingAcks = new Map();
  /** @type {Map<string, {status: string, result?: string, msgId?: string, receivedAt: number}>} */
  #jobs = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  #inFlightResults = new Map();

  #inboundChain = Promise.resolve();

  #tokenRefreshInFlight = null;
  #tokenRefreshFailures = 0;

  #hasRefreshToken = false;
  #hasAccessToken = false;

  #lastError = null;
  #lastConnectedAt = null;
  #lastDisconnectedAt = null;
  #lastInboundAt = null;

  #transitions = [];
  #handlers = new Map();
  #everConnected = false;

  #counters = {
    inbound: 0,
    acksSent: 0,
    resultsSent: 0,
    resultsAcked: 0,
    duplicateMessages: 0,
    droppedResults: 0,
    replayedResults: 0,
    invalidFrames: 0,
    tokenRefreshes: 0,
    reconnects: 0,
  };

  /**
   * @param {Record<string, any>} rawConfig
   */
  constructor(rawConfig = {}) {
    this.#config = resolveConfig(rawConfig);
    this.#logger = this.#config.logger;
    this.#redactor = this.#config.redactor;
    this.#store =
      rawConfig.stateStore ??
      createStateStore({
        stateDir: this.#config.stateDir,
        maxCompletedResults: this.#config.timing.completedResultCacheSize,
      });
    this.#auth =
      rawConfig.auth ??
      createDeviceAuth({
        idaasEndpoint: this.#config.idaasEndpoint,
        clientId: this.#config.clientId,
        audience: this.#config.audience,
        scope: this.#config.scope,
        stateStore: this.#store,
        fetchImpl: this.#config.fetchImpl,
        logger: this.#logger,
        redactor: this.#redactor,
        now: this.#config.now,
        sleep: this.#config.sleep,
      });
    this.#transitions.push({ phase: 'stopped', at: this.#config.now(), reason: 'created' });
  }

  // ---------------------------------------------------------------- events

  /**
   * Subscribe to an event: `connected`, `disconnected`, `message`, `cancel`,
   * `error`, `token-refreshed`, `state`, `result-delivered`.
   * @param {string} event
   * @param {(payload: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (typeof handler !== 'function') throw new LivisConfigError('event handler must be a function');
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** @param {string} event @param {Function} handler */
  off(event, handler) {
    this.#handlers.get(event)?.delete(handler);
  }

  /** @param {string} event */
  #emit(event, payload) {
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        this.#logger.error(`Livis event handler for "${event}" threw`, error);
      }
    }
  }

  /**
   * Wait for the next event, optionally filtered.
   * @param {string} event
   * @param {{timeoutMs?: number, predicate?: (payload: any) => boolean}} [options]
   */
  waitForEvent(event, options = {}) {
    const { timeoutMs = 5_000, predicate } = options;
    return new Promise((resolve, reject) => {
      let timer;
      const unsubscribe = this.on(event, (payload) => {
        if (predicate && !predicate(payload)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(payload);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new LivisTimeoutError(`Timed out waiting for Livis event "${event}"`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  // ------------------------------------------------------------ init/auth

  /** Prepare state store + identities. Safe to call repeatedly. */
  async init() {
    if (this.#initialized) return this;
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = (async () => {
      await this.#store.init();
      if (typeof this.#config.refreshToken === 'string' && this.#config.refreshToken !== '') {
        await this.#store.setRefreshToken(this.#config.refreshToken);
        this.#redactor.register(this.#config.refreshToken);
      }
      const identity = await this.#store.ensureIdentity({
        agentId: this.#config.agentId ?? undefined,
        deviceId: this.#config.deviceId ?? undefined,
        agentIdPrefix: this.#config.wire.agentIdPrefix,
        deviceIdPrefix: this.#config.wire.deviceIdPrefix,
      });
      this.#agentId = identity.agentId;
      this.#deviceId = identity.deviceId;
      this.#hasRefreshToken = (await this.#store.getRefreshToken()) !== null;
      this.#initialized = true;
      this.#logger.debug('Livis client initialised', {
        agentId: this.#agentId,
        deviceId: this.#deviceId,
      });
      return this;
    })().finally(() => {
      this.#initPromise = null;
    });
    return this.#initPromise;
  }

  /** Run the full IDaaS device login. Returns no token material. */
  async login({ force = false, onCode, onPending, signal } = {}) {
    await this.init();
    const result = await this.#auth.login({ force, onCode, onPending, signal });
    this.#hasRefreshToken = true;
    this.#hasAccessToken = true;
    return result;
  }

  /**
   * Seed credentials/identity (P3 after its own login or profile load).
   * Tokens are written through the 0600 store.
   */
  async setCredentials({ refreshToken, accessToken, expiresIn, agentId, deviceId } = {}) {
    await this.init();
    if (typeof refreshToken === 'string' && refreshToken !== '') {
      await this.#store.setRefreshToken(refreshToken);
      this.#redactor.register(refreshToken);
      this.#hasRefreshToken = true;
    }
    if (typeof accessToken === 'string' && accessToken !== '') {
      this.#auth.setAccessToken(accessToken, { expiresIn });
      this.#hasAccessToken = true;
    }
    if (
      (typeof agentId === 'string' && agentId !== '') ||
      (typeof deviceId === 'string' && deviceId !== '')
    ) {
      const identity = await this.#store.ensureIdentity({
        agentId,
        deviceId,
        agentIdPrefix: this.#config.wire.agentIdPrefix,
        deviceIdPrefix: this.#config.wire.deviceIdPrefix,
      });
      this.#agentId = identity.agentId;
      this.#deviceId = identity.deviceId;
    }
    return {
      agentId: this.#agentId,
      deviceId: this.#deviceId,
      hasRefreshToken: this.#hasRefreshToken,
    };
  }

  /** Device-logout: revoke the refresh token + clear local state. */
  async logout({ signal } = {}) {
    await this.init();
    const result = await this.#auth.revoke({ signal });
    this.#hasRefreshToken = false;
    this.#hasAccessToken = false;
    if (this.#started || this.#socket) await this.stop();
    return result;
  }

  async tokenState() {
    await this.init();
    return this.#auth.tokenState();
  }

  getIdentity() {
    return { agentId: this.#agentId, deviceId: this.#deviceId };
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Connect and resolve once the relay accepts the handshake. Rejects with
   * LivisConnectTimeoutError if no handshake within `connectTimeoutMs`;
   * reconnects after a successful start are automatic until `stop()`.
   */
  async start() {
    await this.init();
    if (this.#phase === 'connected') return this;
    if (this.#startPromise) return this.#startPromise;
    if (!this.#hasRefreshToken) {
      this.#setPhase('idle', 'missing-refresh-token');
      throw new LivisAuthRequiredError();
    }

    this.#stopping = false;
    this.#started = true;
    this.#setPhase('connecting', 'start');
    this.#startPromise = new Promise((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
    });
    // Avoid an unhandled rejection if the caller only listens for events.
    this.#startPromise.catch(() => {});
    this.#startDeadlineTimer = setTimeout(() => {
      this.#startDeadlineTimer = null;
      this.#failStart(new LivisConnectTimeoutError());
    }, this.#config.timing.connectTimeoutMs);
    this.#startDeadlineTimer.unref?.();

    void this.#connectOnce(false);
    return this.#startPromise;
  }

  /**
   * Stop supervision and close the socket. In-flight result waits reject with
   * LIVIS_STOPPED; cached results remain for a future duplicate delivery.
   */
  async stop() {
    if (this.#phase === 'stopped' && !this.#socket && !this.#started) return;
    this.#stopping = true;
    this.#started = false;
    this.#clearStartDeadline();
    this.#clearHeartbeat();
    this.#clearReconnectTimer();

    const socket = this.#socket;
    this.#socket = null;
    this.#wsOpen = false;
    this.#handshakeAccepted = false;
    if (socket) {
      try {
        socket.close(1000, 'client-stopped');
      } catch {
        // already closed
      }
    }
    this.#rejectAllAcks(new LivisStoppedError());
    this.#setPhase('stopped', 'stopped');
    if (this.#startReject) this.#settleStart(new LivisStoppedError());
    await this.#inboundChain.catch(() => {});
    this.#stopping = false;
  }

  // -------------------------------------------------------------- connecting

  async #connectOnce(isReconnect) {
    if (!this.#started || this.#stopping) return;
    try {
      const accessToken = await this.#auth.getAccessToken();
      this.#hasAccessToken = true;
      const refreshToken = await this.#store.getRefreshToken();
      if (!refreshToken) throw new LivisAuthRequiredError();
      this.#hasRefreshToken = true;
      this.#redactor.register(accessToken, refreshToken);

      if (!this.#started || this.#stopping) return;
      const url = withProtocolVersion(
        this.#config.websocketUrl,
        this.#config.wire.protocolVersion,
      );
      this.#logger.debug(`Opening Livis relay socket${isReconnect ? ' (reconnect)' : ''}`);
      const socket = new this.#config.WebSocketImpl(url);
      this.#socket = socket;
      this.#wsOpen = false;
      this.#handshakeAccepted = false;
      this.#attachSocket(socket);
    } catch (error) {
      this.#logger.error('Livis connection attempt failed', error);
      this.#recordError(error);
      this.#emit('error', {
        ...errorPayload(error),
        at: this.#config.now(),
      });
      const fatalAuth =
        error instanceof LivisAuthRequiredError ||
        (error instanceof LivisAuthError && !error.retryable);
      if (fatalAuth) {
        this.#hasRefreshToken = false;
        this.#hasAccessToken = false;
        this.#setPhase('idle', 'authentication-required');
        if (this.#startReject) this.#failStart(error);
        else this.#started = false;
        return;
      }
      this.#scheduleReconnect();
    }
  }

  #attachSocket(socket) {
    const onOpen = () => {
      if (socket !== this.#socket) return;
      this.#wsOpen = true;
      this.#setPhase('handshaking', 'socket-open');
      void this.#sendConnect(socket);
    };
    const onMessage = (eventOrData, isBinary) => {
      if (socket !== this.#socket) return;
      let raw;
      if (isBinary !== undefined) {
        raw = isBinary ? eventOrData : eventOrData?.toString?.('utf8');
      } else {
        raw = eventOrData?.data;
      }
      this.#enqueueInbound(raw);
    };
    const onClose = (eventOrCode, reasonBuffer) => {
      let code = 1006;
      let reason = '';
      if (typeof eventOrCode === 'number') {
        code = eventOrCode;
        reason = reasonBuffer ? String(reasonBuffer) : '';
      } else if (eventOrCode && typeof eventOrCode === 'object') {
        code = Number.isFinite(eventOrCode.code) ? eventOrCode.code : 1006;
        reason = typeof eventOrCode.reason === 'string' ? eventOrCode.reason : '';
      }
      this.#handleClose(socket, code, reason);
    };
    const onError = (eventOrError) => {
      if (socket !== this.#socket) return;
      const cause = eventOrError?.error ?? eventOrError;
      this.#logger.warn('Livis relay socket error', cause);
      this.#recordError(
        cause instanceof Error ? cause : new LivisConnectionError('Relay socket error'),
      );
    };

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
    } else if (typeof socket.on === 'function') {
      socket.on('open', onOpen);
      socket.on('message', onMessage);
      socket.on('close', onClose);
      socket.on('error', onError);
    } else {
      throw new LivisConnectionError('WebSocket implementation is not event-target compatible');
    }
  }

  async #sendConnect(socket) {
    try {
      const accessToken = await this.#auth.getAccessToken();
      this.#hasAccessToken = true;
      const refreshToken = await this.#store.getRefreshToken();
      if (!refreshToken) throw new LivisAuthRequiredError();
      this.#redactor.register(accessToken, refreshToken);
      if (socket !== this.#socket || this.#stopping) return;

      const frame = connectEnvelope({
        agentId: this.#agentId,
        deviceId: this.#deviceId,
        accessToken,
        refreshToken,
        client: this.#config.wire.client,
        nodeName: this.#config.wire.nodeName,
        nodeDesc: this.#config.wire.nodeDescription,
        now: this.#config.now,
      });
      if (!this.#sendFrame(frame)) {
        throw new LivisConnectionError('Could not send the connect frame');
      }
      this.#startHeartbeat();
    } catch (error) {
      this.#logger.error('Livis handshake failed', error);
      this.#recordError(error);
      this.#emit('error', { ...errorPayload(error), at: this.#config.now() });
      const fatalAuth =
        error instanceof LivisAuthRequiredError ||
        (error instanceof LivisAuthError && !error.retryable);
      if (fatalAuth) {
        this.#hasRefreshToken = false;
        this.#setPhase('idle', 'authentication-required');
        if (this.#startReject) this.#failStart(error);
      }
      this.#closeSocket(1011, 'handshake-failed');
    }
  }

  #handleClose(socket, code, reason) {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#wsOpen = false;
    this.#handshakeAccepted = false;
    this.#clearHeartbeat();
    this.#rejectAllAcks(new LivisDisconnectedError());
    this.#lastDisconnectedAt = this.#config.now();
    this.#logger.warn(`Livis relay socket closed (code ${code})`);
    this.#emit('disconnected', {
      code,
      reason: this.#redactor.redactString(reason),
      at: this.#config.now(),
    });

    if (this.#stopping || !this.#started) {
      this.#setPhase('stopped', 'socket-closed');
      return;
    }
    this.#setPhase('reconnecting', 'socket-closed');
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (!this.#started || this.#stopping) return;
    if (this.#reconnectTimer) return;
    const timing = this.#config.timing;
    const exponent = Math.min(this.#reconnectAttempt, 6);
    const base = Math.min(
      timing.reconnectMaxMs,
      timing.reconnectBaseMs * (RELAY_POLICY.reconnectFactor ** exponent),
    );
    const jitter = 0.8 + this.#config.random() * 0.4;
    const delay = Math.max(10, Math.round(base * jitter));
    this.#reconnectAttempt += 1;
    this.#reconnectCount += 1;
    this.#counters.reconnects = this.#reconnectCount;
    if (this.#phase !== 'reconnecting') this.#setPhase('reconnecting', 'reconnect-scheduled');
    this.#logger.info(
      `Reconnecting to Livis relay in ${delay}ms (attempt ${this.#reconnectAttempt})`,
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connectOnce(true);
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #failStart(error) {
    if (!this.#startReject) return;
    this.#logger.error('Livis client could not start', error);
    this.#started = false;
    this.#stopping = true;
    this.#clearStartDeadline();
    this.#clearHeartbeat();
    this.#clearReconnectTimer();
    const socket = this.#socket;
    this.#socket = null;
    this.#wsOpen = false;
    if (socket) {
      try {
        socket.close(1000, 'start-failed');
      } catch {
        // already closed
      }
    }
    this.#setPhase('stopped', 'start-failed');
    this.#settleStart(error);
  }

  #settleStart(error) {
    const reject = this.#startReject;
    const resolve = this.#startResolve;
    this.#startReject = null;
    this.#startResolve = null;
    this.#startPromise = null;
    this.#clearStartDeadline();
    if (error) reject?.(error);
    else resolve?.(this);
  }

  // -------------------------------------------------------------- heartbeats

  #startHeartbeat() {
    this.#clearHeartbeat();
    this.#heartbeatCount = 0;
    this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(), this.#config.timing.heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  #sendHeartbeat() {
    if (!this.#wsOpen || this.#phase === 'stopped') return;
    const frame = envelope('heartbeat', {
      agentId: this.#agentId,
      deviceId: this.#deviceId,
      jobId: uuid(),
      payload: {},
      client: this.#config.wire.client,
      nodeType: this.#config.wire.nodeType,
      now: this.#config.now,
    });
    if (this.#sendFrame(frame)) {
      this.#heartbeatCount += 1;
      this.#lastHeartbeatAt = this.#config.now();
    }
  }

  #clearHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #clearStartDeadline() {
    if (this.#startDeadlineTimer) {
      clearTimeout(this.#startDeadlineTimer);
      this.#startDeadlineTimer = null;
    }
  }

  // ---------------------------------------------------------------- inbound

  #enqueueInbound(raw) {
    this.#inboundChain = this.#inboundChain
      .then(() => this.#handleInbound(raw))
      .catch((error) => {
        this.#logger.error('Unhandled error while processing an inbound frame', error);
      });
  }

  async #handleInbound(raw) {
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      this.#counters.invalidFrames += 1;
      this.#logger.warn('Ignoring invalid Livis frame', {
        reason: parsed.reason,
        type: parsed.type ?? null,
      });
      return;
    }
    this.#counters.inbound += 1;
    this.#lastInboundAt = this.#config.now();

    switch (parsed.kind) {
      case 'connected':
        this.#handleConnected();
        return;
      case 'message':
        await this.#handleSendMessage(parsed.task);
        return;
      case 'cancel':
        this.#handleCancel(parsed.jobId);
        return;
      case 'ack':
        this.#handleResultAck(parsed.refMsgId ?? parsed.jobId, parsed.jobId);
        return;
      case 'token_expiring':
        void this.#handleTokenExpiring();
        return;
      case 'token_refreshed':
        this.#tokenRefreshFailures = 0;
        this.#logger.info('Livis gateway acknowledged token refresh');
        this.#emit('token-refreshed', { ok: true, at: this.#config.now() });
        return;
      case 'error': {
        const error = new LivisError(`Relay error: ${parsed.reason}`, {
          code: parsed.code ?? 'LIVIS_RELAY_ERROR',
          retryable: true,
        });
        this.#logger.warn('Livis relay reported an error', {
          reason: parsed.reason,
          code: parsed.code ?? null,
        });
        this.#recordError(error);
        this.#emit('error', { ...errorPayload(error), at: this.#config.now() });
        this.#closeSocket(1011, 'relay-error');
        return;
      }
      case 'unknown':
      default:
        this.#logger.debug(`Ignoring unsupported Livis frame type ${parsed.type}`);
    }
  }

  #handleConnected() {
    if (this.#handshakeAccepted) return;
    this.#handshakeAccepted = true;
    this.#everConnected = true;
    this.#reconnectAttempt = 0;
    this.#tokenRefreshFailures = 0;
    this.#lastConnectedAt = this.#config.now();
    this.#lastError = null;
    this.#setPhase('connected', 'handshake-accepted');
    this.#logger.info('Livis relay connected');
    this.#emit('connected', {
      agentId: this.#agentId,
      deviceId: this.#deviceId,
      at: this.#lastConnectedAt,
    });
    this.#settleStart(null);
  }

  async #handleSendMessage(task) {
    const jobId = task.jobId;
    if (this.#config.autoAck) this.#sendAckFrame('ack_send_message', jobId);
    this.#logger.info(`Inbound Livis job ${jobId}`);

    const known = this.#jobs.get(jobId);
    if (known) {
      this.#counters.duplicateMessages += 1;
      if (known.status === 'active' || known.status === 'result-pending') {
        this.#logger.info(`Ignoring duplicate inbound job ${jobId} (already in progress)`);
        return;
      }
      if (known.status === 'canceled') {
        this.#logger.info(`Ignoring duplicate inbound job ${jobId} (job was canceled)`);
        return;
      }
      void this.#replayCachedResult(jobId, 'duplicate-delivery');
      return;
    }

    const cached = await this.#store.getCompletedResult(jobId);
    if (cached) {
      this.#jobs.set(jobId, { status: 'completed', result: cached, receivedAt: this.#config.now() });
      this.#counters.duplicateMessages += 1;
      void this.#replayCachedResult(jobId, 'duplicate-after-restart');
      return;
    }

    this.#jobs.set(jobId, {
      status: 'active',
      msgId: task.msgId,
      receivedAt: this.#config.now(),
    });
    this.#trimJobs();
    this.#emit('message', task);
  }

  async #replayCachedResult(jobId, reason) {
    if (!this.#config.replayCompletedResults) {
      this.#logger.info(`Cached result for duplicate job ${jobId} not replayed (disabled)`);
      return;
    }
    const result = this.#jobs.get(jobId)?.result ?? (await this.#store.getCompletedResult(jobId));
    if (!result) {
      this.#logger.warn(`Duplicate job ${jobId} has no cached result to replay`);
      return;
    }
    if (this.#inFlightResults.has(jobId)) return;
    this.#logger.info(`Replaying cached result for duplicate job ${jobId} (${reason})`);
    const promise = this.#deliverResult(jobId, result, { replay: true })
      .then((outcome) => {
        if (outcome?.sent) this.#counters.replayedResults += 1;
        return outcome;
      })
      .catch((error) => {
        this.#logger.warn(`Cached result replay failed for job ${jobId}`, error);
        this.#recordError(error);
        return null;
      })
      .finally(() => {
        this.#inFlightResults.delete(jobId);
      });
    this.#inFlightResults.set(jobId, promise);
  }

  #handleCancel(jobId) {
    this.#logger.info(`Inbound cancel for Livis job ${jobId}`);
    this.#sendAckFrame('ack_cancel_chat', jobId);
    this.#jobs.set(jobId, { status: 'canceled', receivedAt: this.#config.now() });
    this.#trimJobs();
    for (const waiter of [...this.#pendingAcks.values()]) {
      if (waiter.jobId !== jobId) continue;
      waiter.reject(
        new LivisError('Livis job was canceled while awaiting result ack', {
          code: 'LIVIS_JOB_CANCELED',
        }),
      );
    }
    this.#emit('cancel', { jobId, at: this.#config.now() });
  }

  #handleResultAck(refMsgId, jobId) {
    // Gateways ack a send_result by referencing that frame's metadata.msg_id in
    // payload.ref_msg_id. Fall back to job_id for gateways that omit ref_msg_id.
    let waiter = refMsgId ? this.#pendingAcks.get(refMsgId) : undefined;
    if (!waiter && jobId) {
      for (const candidate of this.#pendingAcks.values()) {
        if (candidate.jobId === jobId) {
          waiter = candidate;
          break;
        }
      }
    }
    if (waiter) {
      waiter.resolve(true);
      return;
    }
    const job = jobId ? this.#jobs.get(jobId) : undefined;
    if (job?.status === 'completed') {
      this.#logger.debug(`Late duplicate ack_send_result for completed job ${jobId}`);
      return;
    }
    this.#logger.debug(`Ignoring ack_send_result for unknown job ${jobId ?? refMsgId}`);
  }

  async #handleTokenExpiring() {
    if (this.#tokenRefreshInFlight) {
      this.#logger.info('token_expiring received while a refresh is already in flight');
      return;
    }
    this.#tokenRefreshInFlight = (async () => {
      try {
        this.#logger.info('Livis gateway requested token refresh');
        const accessToken = await this.#auth.forceRefresh();
        const refreshToken = await this.#store.getRefreshToken();
        if (!refreshToken) throw new LivisAuthRequiredError();
        this.#hasAccessToken = true;
        this.#hasRefreshToken = true;
        this.#redactor.register(accessToken, refreshToken);

        const frame = envelope('token_refresh', {
          agentId: this.#agentId,
          deviceId: this.#deviceId,
          jobId: uuid(),
          payload: { token: accessToken, refresh_token: refreshToken },
          client: this.#config.wire.client,
          nodeType: this.#config.wire.nodeType,
          now: this.#config.now,
        });
        if (!this.#sendFrame(frame)) {
          throw new LivisNotConnectedError('Could not send token_refresh');
        }
        this.#counters.tokenRefreshes += 1;
        this.#tokenRefreshFailures = 0;
        this.#logger.info('Livis token refreshed and reported to the gateway');
        this.#emit('token-refreshed', { ok: true, at: this.#config.now() });
      } catch (error) {
        this.#tokenRefreshFailures += 1;
        this.#logger.warn(
          `Livis token refresh failed (${this.#tokenRefreshFailures}/${this.#config.timing.maxTokenRefreshFailures})`,
          error,
        );
        this.#recordError(error);
        this.#emit('error', { ...errorPayload(error), at: this.#config.now() });
        if (this.#tokenRefreshFailures >= this.#config.timing.maxTokenRefreshFailures) {
          this.#logger.warn('Closing Livis connection after repeated token refresh failures');
          this.#closeSocket(1008, 'token-refresh-failed');
        }
      } finally {
        this.#tokenRefreshInFlight = null;
      }
    })();
    await this.#tokenRefreshInFlight;
  }

  // ----------------------------------------------------------------- outbound

  #sendFrame(frame) {
    if (!this.#socket || !this.#wsOpen) return false;
    try {
      this.#socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.#logger.warn('Failed to send a Livis frame', error);
      return false;
    }
  }

  #sendAckFrame(type, jobId) {
    const frame = envelope(type, {
      agentId: this.#agentId,
      deviceId: this.#deviceId,
      jobId,
      payload: {},
      client: this.#config.wire.client,
      nodeType: this.#config.wire.nodeType,
      now: this.#config.now,
    });
    if (this.#sendFrame(frame)) this.#counters.acksSent += 1;
  }

  /** Manual ack_send_message (only needed when autoAck=false). */
  ackMessage(jobId) {
    this.#sendAckFrame('ack_send_message', jobId);
  }

  /** Manual ack_cancel_chat (only needed when autoAck=false). */
  ackCancel(jobId) {
    this.#sendAckFrame('ack_cancel_chat', jobId);
  }

  #createAckWaiter(ackKey, jobId, timeoutMs) {
    /** @type {(value: boolean) => void} */
    let resolveFn;
    /** @type {(error: Error) => void} */
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.#pendingAcks.delete(ackKey);
      fn(value);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.#pendingAcks.delete(ackKey);
      resolveFn(false);
    }, timeoutMs);
    timer.unref?.();
    this.#pendingAcks.set(ackKey, {
      promise,
      jobId,
      resolve: (value) => finish(resolveFn, value),
      reject: (error) => finish(rejectFn, error),
    });
    return {
      promise,
      cancel: (error) => finish(rejectFn, error),
    };
  }

  #rejectAllAcks(error) {
    for (const waiter of [...this.#pendingAcks.values()]) {
      waiter.reject(error);
    }
    this.#pendingAcks.clear();
  }

  /**
   * Send the final result for a job. Waits for ack_send_result and retries up
   * to `maxResultAttempts` (initial + 3 retries), then throws
   * LivisResultNotAckedError. The result is persisted before the first send.
   *
   * @param {string} jobId
   * @param {{text: string, files?: unknown[]}} input
   */
  async sendResult(jobId, input = {}) {
    await this.init();
    if (typeof jobId !== 'string' || jobId === '') {
      throw new LivisConfigError('sendResult requires a non-empty jobId');
    }
    const { text, files } = input;
    if (typeof text !== 'string') {
      throw new LivisConfigError('sendResult requires a text string');
    }
    if (files !== undefined && !Array.isArray(files)) {
      throw new LivisConfigError('sendResult files must be an array when provided');
    }
    const data = resultData(text, files);

    if (this.#jobs.get(jobId)?.status === 'completed') {
      this.#counters.droppedResults += 1;
      this.#logger.info(`Duplicate send_result dropped for completed job ${jobId}`);
      return { sent: false, duplicate: true, attempts: 0, jobId };
    }
    const inFlight = this.#inFlightResults.get(jobId);
    if (inFlight) return inFlight;

    let resolveFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = { resolve, reject };
    });
    this.#inFlightResults.set(jobId, promise);
    void (async () => {
      try {
        resolveFn.resolve(await this.#deliverResult(jobId, data, { replay: false }));
      } catch (error) {
        resolveFn.reject(error);
      } finally {
        this.#inFlightResults.delete(jobId);
      }
    })();
    return promise;
  }

  /**
   * Retry the persisted result for a job after an ack failure.
   * @param {string} jobId
   */
  async retryResult(jobId) {
    await this.init();
    const result = this.#jobs.get(jobId)?.result ?? (await this.#store.getCompletedResult(jobId));
    if (!result) throw new LivisConfigError(`No cached result for job ${jobId}`);
    if (this.#inFlightResults.has(jobId)) return this.#inFlightResults.get(jobId);
    const promise = this.#deliverResult(jobId, result, { replay: true }).finally(() => {
      this.#inFlightResults.delete(jobId);
    });
    this.#inFlightResults.set(jobId, promise);
    return promise;
  }

  async #deliverResult(jobId, data, { replay }) {
    if (!this.#wsOpen || this.#phase !== 'connected') {
      throw new LivisNotConnectedError('Cannot deliver a result while the relay is disconnected');
    }
    // Persist BEFORE sending so a duplicate delivery can replay identical bytes.
    await this.#store.rememberCompletedResult(jobId, data);
    this.#jobs.set(jobId, {
      status: 'result-pending',
      result: data,
      receivedAt: this.#jobs.get(jobId)?.receivedAt ?? this.#config.now(),
    });

    for (let attempt = 1; attempt <= this.#config.timing.maxResultAttempts; attempt += 1) {
      if (!this.#wsOpen || this.#phase !== 'connected') {
        throw new LivisNotConnectedError(
          'Relay disconnected while delivering a result; cached for replay',
        );
      }
      const msgId = uuid();
      const waiter = this.#createAckWaiter(msgId, jobId, this.#config.timing.ackTimeoutMs);
      const frame = envelope('send_result', {
        agentId: this.#agentId,
        deviceId: this.#deviceId,
        jobId,
        msgId,
        payload: { data },
        client: this.#config.wire.client,
        nodeType: this.#config.wire.nodeType,
        now: this.#config.now,
      });
      if (!this.#sendFrame(frame)) {
        waiter.cancel(new LivisNotConnectedError('Could not send send_result'));
        throw new LivisNotConnectedError('Could not send send_result');
      }
      this.#counters.resultsSent += 1;
      this.#logger.info(
        `Livis send_result sent for job ${jobId} (attempt ${attempt}/${this.#config.timing.maxResultAttempts})`,
      );
      const acked = await waiter.promise;
      if (acked) {
        this.#jobs.set(jobId, {
          status: 'completed',
          result: data,
          receivedAt: this.#jobs.get(jobId)?.receivedAt ?? this.#config.now(),
          completedAt: this.#config.now(),
        });
        this.#counters.resultsAcked += 1;
        this.#trimJobs();
        this.#logger.info(`Livis result acknowledged for job ${jobId}`);
        this.#emit('result-delivered', {
          jobId,
          replay,
          attempts: attempt,
          at: this.#config.now(),
        });
        return { sent: true, duplicate: false, replay, attempts: attempt, jobId };
      }
      this.#logger.warn(
        `Livis send_result ack timed out for job ${jobId} (attempt ${attempt}/${this.#config.timing.maxResultAttempts})`,
      );
    }

    const error = new LivisResultNotAckedError(jobId, this.#config.timing.maxResultAttempts);
    this.#recordError(error);
    this.#logger.error(`Livis result delivery failed for job ${jobId}; cached for replay`);
    this.#emit('error', { ...errorPayload(error), at: this.#config.now() });
    throw error;
  }

  // ---------------------------------------------------------------- uploads

  /**
   * Upload one file and return the metadata to embed in sendResult files[].
   * @param {string} filePath
   * @param {{jobId: string, signal?: AbortSignal}} options
   */
  async uploadFile(filePath, { jobId, signal } = {}) {
    const uploaded = await this.uploadFiles([filePath], { jobId, signal });
    return uploaded[0];
  }

  /**
   * Upload files inside `uploadRoot` (whitelisted document types).
   * @param {string[]} filePaths
   * @param {{jobId: string, signal?: AbortSignal}} options
   */
  async uploadFiles(filePaths, { jobId, signal } = {}) {
    await this.init();
    if (typeof jobId !== 'string' || jobId === '') {
      throw new LivisConfigError('jobId is required to upload files');
    }
    if (!this.#config.uploadRoot) {
      throw new LivisConfigError('uploadRoot is required to upload files');
    }
    const attempt = async () => {
      const accessToken = await this.#auth.getAccessToken();
      this.#hasAccessToken = true;
      return uploadFilesFromDisk({
        fetchImpl: this.#config.fetchImpl,
        httpUrl: this.#config.httpUrl,
        client: this.#config.wire.client,
        jobId,
        accessToken,
        uploadRoot: this.#config.uploadRoot,
        files: filePaths,
        signal,
      });
    };
    try {
      return await attempt();
    } catch (error) {
      if ((error?.status === 401 || error?.status === 403) && this.#hasRefreshToken) {
        this.#logger.warn('Upload rejected; refreshing access token and retrying once');
        await this.#auth.forceRefresh();
        return attempt();
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ health

  /** Secret-free health/diagnostic snapshot. */
  health() {
    const jobs = {
      tracked: this.#jobs.size,
      active: 0,
      resultPending: 0,
      completed: 0,
      canceled: 0,
    };
    for (const job of this.#jobs.values()) {
      if (job.status === 'active') jobs.active += 1;
      else if (job.status === 'result-pending') jobs.resultPending += 1;
      else if (job.status === 'completed') jobs.completed += 1;
      else if (job.status === 'canceled') jobs.canceled += 1;
    }

    return {
      phase: this.#phase,
      connected: this.#phase === 'connected',
      handshakeAccepted: this.#handshakeAccepted,
      environment: this.#config.environment,
      client: this.#config.wire.client,
      nodeType: this.#config.wire.nodeType,
      agentId: this.#agentId,
      deviceId: this.#deviceId,
      hasRefreshToken: this.#hasRefreshToken,
      hasAccessToken: this.#hasAccessToken,
      websocketUrlConfigured: this.#config.websocketUrl.startsWith('wss:'),
      heartbeat: {
        intervalMs: this.#config.timing.heartbeatMs,
        count: this.#heartbeatCount,
        lastAt: this.#lastHeartbeatAt,
      },
      lastConnectedAt: this.#lastConnectedAt,
      lastDisconnectedAt: this.#lastDisconnectedAt,
      lastInboundAt: this.#lastInboundAt,
      lastError: this.#lastError ? { ...this.#lastError } : null,
      reconnectAttempts: this.#reconnectAttempt,
      reconnects: this.#reconnectCount,
      tokenRefreshFailures: this.#tokenRefreshFailures,
      tokenRefreshInFlight: this.#tokenRefreshInFlight !== null,
      pendingResultAcks: this.#pendingAcks.size,
      jobs,
      counters: { ...this.#counters },
      transitions: this.#transitions.slice(-20).map((entry) => ({ ...entry })),
      sampledAt: this.#config.now(),
    };
  }

  // ----------------------------------------------------------------- private

  #setPhase(phase, reason) {
    if (!CLIENT_PHASES.includes(phase)) return;
    if (this.#phase === phase) return;
    this.#phase = phase;
    const entry = { phase, at: this.#config.now(), reason };
    this.#transitions.push(entry);
    if (this.#transitions.length > MAX_TRANSITIONS) this.#transitions.shift();
    this.#logger.debug(`Livis phase -> ${phase} (${reason})`);
    this.#emit('state', entry);
    if (this.#config.onHealthChange) {
      try {
        this.#config.onHealthChange(this.health());
      } catch (error) {
        this.#logger.warn('onHealthChange callback threw', error);
      }
    }
  }

  #recordError(error) {
    this.#lastError = {
      message: this.#redactor.redactString(error?.message ?? String(error)),
      code: typeof error?.code === 'string' ? error.code : 'LIVIS_ERROR',
      at: this.#config.now(),
    };
  }

  #closeSocket(code, reason) {
    const socket = this.#socket;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // ignore
    }
  }

  #trimJobs() {
    while (this.#jobs.size > 100) {
      let victim = null;
      for (const [jobId, job] of this.#jobs) {
        if (job.status === 'completed' || job.status === 'canceled') {
          victim = jobId;
          break;
        }
      }
      if (!victim) break;
      this.#jobs.delete(victim);
    }
  }

}

/**
 * Create a client; call `await client.start()` (which runs `init()` first) or
 * `await client.init()` when only auth/upload APIs are needed.
 * @param {Record<string, any>} config
 */
export function createLivisClient(config = {}) {
  return new LivisClient(config);
}
