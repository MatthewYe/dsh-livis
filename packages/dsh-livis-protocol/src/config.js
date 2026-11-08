/**
 * Configuration resolution and validation.
 *
 * Everything effectful is injectable: fetch, WebSocket, clock, sleep, random.
 * That is what lets the entire test suite point at a local fake hub instead of
 * the real Livis gateway.
 */

import { resolve } from 'node:path';
import { LIVIS_PRODUCTION, LIVIS_WIRE, RELAY_POLICY } from './constants.js';
import { LivisConfigError } from './errors.js';
import { createRedactor, wrapLogger } from './redact.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

function absoluteUrl(name, value, schemes, { allowInsecureLocalhost = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LivisConfigError(`${name} must be an absolute URL`);
  }
  if (!schemes.includes(url.protocol)) {
    throw new LivisConfigError(`${name} must use one of ${schemes.join(', ')}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') {
    if (!(allowInsecureLocalhost && isLoopback(url.hostname))) {
      throw new LivisConfigError(
        `${name} must use a secure scheme unless it targets localhost (testing)`,
      );
    }
  }
  return value;
}

function positiveInt(name, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LivisConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * @param {Record<string, any>} [raw]
 */
export function resolveConfig(raw = {}) {
  const stateDir = raw.stateDir;
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    throw new LivisConfigError('stateDir is required (a directory the client may own with 0700)');
  }

  const websocketUrl = absoluteUrl(
    'websocketUrl',
    raw.websocketUrl ?? LIVIS_PRODUCTION.websocketUrl,
    ['ws:', 'wss:'],
  );
  const httpUrl = absoluteUrl('httpUrl', raw.httpUrl ?? LIVIS_PRODUCTION.httpUrl, ['http:', 'https:']);
  const idaasEndpoint = absoluteUrl(
    'idaasEndpoint',
    raw.idaasEndpoint ?? LIVIS_PRODUCTION.idaasEndpoint,
    ['http:', 'https:'],
  );

  const fetchImpl = raw.fetch ?? raw.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new LivisConfigError('A fetch implementation is required (config.fetch or global fetch)');
  }

  const WebSocketImpl = raw.WebSocket ?? raw.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw new LivisConfigError(
      'A WebSocket implementation is required (config.WebSocket or global WebSocket)',
    );
  }

  const timing = {
    heartbeatMs: positiveInt('heartbeatMs', raw.heartbeatMs ?? RELAY_POLICY.heartbeatMs, { min: 10 }),
    connectTimeoutMs: positiveInt(
      'connectTimeoutMs',
      raw.connectTimeoutMs ?? RELAY_POLICY.connectTimeoutMs,
      { min: 50 },
    ),
    ackTimeoutMs: positiveInt('ackTimeoutMs', raw.ackTimeoutMs ?? RELAY_POLICY.ackTimeoutMs, { min: 10 }),
    maxResultAttempts: positiveInt(
      'maxResultAttempts',
      raw.maxResultAttempts ?? RELAY_POLICY.maxResultAttempts,
      { min: 1, max: 10 },
    ),
    reconnectBaseMs: positiveInt(
      'reconnectBaseMs',
      raw.reconnectBaseMs ?? RELAY_POLICY.reconnectBaseMs,
      { min: 10 },
    ),
    reconnectMaxMs: positiveInt(
      'reconnectMaxMs',
      raw.reconnectMaxMs ?? RELAY_POLICY.reconnectMaxMs,
      { min: 10 },
    ),
    maxTokenRefreshFailures: positiveInt(
      'maxTokenRefreshFailures',
      raw.maxTokenRefreshFailures ?? RELAY_POLICY.maxTokenRefreshFailures,
      { min: 1, max: 10 },
    ),
    completedResultCacheSize: positiveInt(
      'completedResultCacheSize',
      raw.completedResultCacheSize ?? RELAY_POLICY.completedResultCacheSize,
      { min: 1, max: 1000 },
    ),
  };
  if (timing.reconnectMaxMs < timing.reconnectBaseMs) {
    throw new LivisConfigError('reconnectMaxMs must be >= reconnectBaseMs');
  }

  const redactor = createRedactor(...(Array.isArray(raw.redactSecrets) ? raw.redactSecrets : []));
  if (typeof raw.refreshToken === 'string') redactor.register(raw.refreshToken);

  const logger = raw.logger ? wrapLogger(raw.logger, redactor, { level: raw.logLevel ?? 'info' }) : wrapLogger(console, redactor, { level: raw.logLevel ?? 'info' });

  const wire = {
    client: raw.client ?? LIVIS_WIRE.client,
    nodeType: raw.nodeType ?? LIVIS_WIRE.nodeType,
    nodeName: raw.nodeName ?? LIVIS_WIRE.nodeName,
    nodeDescription: raw.nodeDescription ?? LIVIS_WIRE.nodeDescription,
    agentIdPrefix: raw.agentIdPrefix ?? LIVIS_WIRE.agentIdPrefix,
    deviceIdPrefix: raw.deviceIdPrefix ?? LIVIS_WIRE.deviceIdPrefix,
    protocolVersion: raw.protocolVersion ?? LIVIS_WIRE.protocolVersion,
  };
  for (const key of ['client', 'nodeType', 'agentIdPrefix', 'deviceIdPrefix']) {
    if (typeof wire[key] !== 'string' || wire[key] === '') {
      throw new LivisConfigError(`wire.${key} must be a non-empty string`);
    }
  }

  return {
    stateDir: resolve(stateDir),
    uploadRoot: raw.uploadRoot ? resolve(raw.uploadRoot) : null,
    environment: raw.environment ?? 'custom',
    websocketUrl,
    httpUrl,
    idaasEndpoint,
    clientId: raw.clientId ?? LIVIS_PRODUCTION.clientId,
    audience: raw.audience ?? LIVIS_PRODUCTION.audience,
    scope: raw.scope ?? LIVIS_PRODUCTION.scope,
    wire,
    timing,
    fetchImpl,
    WebSocketImpl,
    redactor,
    logger,
    now: raw.now ?? Date.now,
    sleep: raw.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: raw.random ?? Math.random,
    autoAck: raw.autoAck ?? true,
    replayCompletedResults: raw.replayCompletedResults ?? true,
    agentId: raw.agentId ?? null,
    deviceId: raw.deviceId ?? null,
    refreshToken: raw.refreshToken ?? null,
    onHealthChange: typeof raw.onHealthChange === 'function' ? raw.onHealthChange : null,
  };
}
