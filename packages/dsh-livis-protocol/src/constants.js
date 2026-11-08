/**
 * Wire constants for the Livis PC gateway, behavior-compatible with the
 * official Hermes v0.1.9 client (the behavioral baseline).
 *
 * The official package is used only as a reference implementation; this
 * module is an independent rewrite.
 */

/** Production endpoints (from the official Hermes v0.1.9 config). */
export const LIVIS_PRODUCTION = Object.freeze({
  clientId: '6qxd1MLZhAtdWipnmXe1dd',
  audience: 'rZgT0SETDNueMVAhfRN10',
  scope: 'super',
  idaasEndpoint: 'https://id.lixiang.com/api',
  websocketUrl: 'wss://livis-pc-kit-gateway.livis.com/api/v1/ws',
  httpUrl: 'https://livis-pc-kit-gateway.livis.com',
});

/**
 * Values fixed by the Livis gateway protocol. These are the fields G2-1
 * asserts on the `connect` frame.
 */
export const LIVIS_WIRE = Object.freeze({
  protocolVersion: '1',
  client: 'hermes',
  nodeType: 'personl-device', // historic spelling, kept for compatibility
  nodeName: 'Hermes Agent',
  nodeDescription: 'personl-device Hermes Agent',
  agentIdPrefix: 'hermes-',
  deviceIdPrefix: 'pc_',
  uploadPath: '/api/v1/files/upload',
  deviceCodeGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
  offlineScope: 'super offline_access',
  protocolVersionQuery: 'protocol_version',
});

/** Timing / retry policy. Defaults mirror the official client. */
export const RELAY_POLICY = Object.freeze({
  heartbeatMs: 30_000,
  connectTimeoutMs: 30_000,
  ackTimeoutMs: 30_000,
  /** initial send + 3 retries = 4 send_result frames */
  maxResultAttempts: 4,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 60_000,
  reconnectFactor: 2,
  /** extra wait per `slow_down` response (RFC 8628) */
  slowDownIncrementMs: 5_000,
  maxPollIntervalMs: 60_000,
  maxTokenRefreshFailures: 3,
  /** cap retries for transient IDaaS 429/5xx/network failures */
  maxAuthTransientRetries: 3,
  completedResultCacheSize: 100,
  httpTimeoutMs: 120_000,
});

/** File upload whitelist (official behavior). */
export const FILE_POLICY = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxFiles: 10,
  allowedExtensions: Object.freeze(['pdf', 'html', 'htm', 'md', 'markdown', 'doc', 'docx']),
  mimeTypes: Object.freeze({
    pdf: 'application/pdf',
    html: 'text/html',
    htm: 'text/html',
    md: 'text/markdown',
    markdown: 'text/markdown',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }),
});

/** Client phases exposed by `health()`, in lifecycle order. */
export const CLIENT_PHASES = Object.freeze([
  'stopped',
  'idle',
  'connecting',
  'handshaking',
  'connected',
  'reconnecting',
]);

/** Inbound frame types this client understands. */
export const INBOUND_TYPES = Object.freeze([
  'connected',
  'send_message',
  'cancel_chat',
  'ack_send_result',
  'token_expiring',
  'token_refreshed',
  'error',
]);

export const STATE_FILE_NAME = 'state.json';
export const STATE_DIR_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;
