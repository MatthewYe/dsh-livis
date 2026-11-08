/**
 * Wire framing and inbound parsing.
 *
 * Behavior mirrors the official Hermes v0.1.9 client:
 *  - `connect` has a special envelope (no device_id in metadata, no nodeType
 *    in payload), everything else uses the common envelope with
 *    payload.nodeType = "personl-device".
 *  - inbound `send_message.payload.data` is either a JSON string or an object.
 *  - outbound `send_result.payload.data` is a *nested compact JSON string*.
 *
 * Nothing in this module throws on malformed input; parsing errors are
 * returned as `{ok:false, reason}` so the connection loop can log and continue.
 */

import { randomUUID } from 'node:crypto';
import { LIVIS_WIRE } from './constants.js';

export function uuid() {
  return randomUUID();
}

/** @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Append the protocol version query parameter the gateway expects.
 * @param {string} websocketUrl
 * @param {string} [version]
 */
export function withProtocolVersion(websocketUrl, version = LIVIS_WIRE.protocolVersion) {
  const url = new URL(websocketUrl);
  url.searchParams.set(LIVIS_WIRE.protocolVersionQuery, version);
  return url.toString();
}

/**
 * Build the `connect` frame. Shape is pinned to official Hermes v0.1.9:
 * metadata has {msg_id, job_id, agent_id, client, timestamp} — deliberately
 * no device_id — and payload has no nodeType.
 *
 * @param {{
 *   agentId: string,
 *   deviceId: string,
 *   accessToken: string,
 *   refreshToken: string,
 *   client?: string,
 *   nodeName?: string,
 *   nodeDesc?: string,
 *   msgId?: string,
 *   jobId?: string,
 *   now?: () => number,
 * }} input
 */
export function connectEnvelope(input) {
  const {
    agentId,
    deviceId,
    accessToken,
    refreshToken,
    client = LIVIS_WIRE.client,
    nodeName = LIVIS_WIRE.nodeName,
    nodeDesc = LIVIS_WIRE.nodeDescription,
    msgId = uuid(),
    jobId = uuid(),
    now = Date.now,
  } = input;
  return {
    type: 'connect',
    metadata: {
      msg_id: msgId,
      job_id: jobId,
      agent_id: agentId,
      client,
      timestamp: now(),
    },
    payload: {
      device_id: deviceId,
      node_name: nodeName,
      node_desc: nodeDesc,
      client,
      token: accessToken,
      refresh_token: refreshToken,
    },
  };
}

/**
 * Build a common envelope: metadata always carries msg_id/job_id/agent_id/
 * device_id/client/timestamp and payload always carries nodeType.
 *
 * @param {string} type
 * @param {{
 *   agentId: string,
 *   deviceId: string,
 *   jobId: string,
 *   payload?: Record<string, unknown>,
 *   client?: string,
 *   nodeType?: string,
 *   msgId?: string,
 *   now?: () => number,
 * }} input
 */
export function envelope(type, input) {
  const {
    agentId,
    deviceId,
    jobId,
    payload = {},
    client = LIVIS_WIRE.client,
    nodeType = LIVIS_WIRE.nodeType,
    msgId = uuid(),
    now = Date.now,
  } = input;
  const outPayload = { ...payload };
  if (outPayload.nodeType === undefined) outPayload.nodeType = nodeType;
  return {
    type,
    metadata: {
      msg_id: msgId,
      job_id: jobId,
      agent_id: agentId,
      device_id: deviceId,
      client,
      timestamp: now(),
    },
    payload: outPayload,
  };
}

/**
 * Encode the nested result data sent in `send_result.payload.data`.
 * Official format: compact JSON, no spaces, files omitted when empty.
 * @param {string} text
 * @param {unknown[]} [files]
 */
export function resultData(text, files) {
  const data = { text: String(text) };
  if (Array.isArray(files) && files.length > 0) data.files = files;
  return JSON.stringify(data);
}

/**
 * Parse a nested result data string back into an object (inverse of
 * resultData; used by tests and P3 diagnostics).
 * @param {unknown} data
 * @returns {{text: string, files?: unknown[]}|null}
 */
export function parseResultData(data) {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!isPlainObject(parsed)) return null;
    if (typeof parsed.text !== 'string') return null;
    return /** @type {{text: string, files?: unknown[]}} */ (parsed);
  } catch {
    return null;
  }
}

/**
 * Parse an inbound `send_message` frame into a task.
 * @param {Record<string, unknown>} frame
 * @returns {{ok: true, task: object} | {ok: false, reason: string}}
 */
export function parseTaskEnvelope(frame) {
  const { metadata, payload } = frame ?? {};
  if (!isPlainObject(metadata)) return { ok: false, reason: 'metadata-not-object' };
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload-not-object' };

  const msgId = nonEmptyString(metadata.msg_id);
  if (!msgId) return { ok: false, reason: 'missing-msg-id' };
  const jobId = nonEmptyString(metadata.job_id);
  if (!jobId) return { ok: false, reason: 'missing-job-id' };

  let data = payload.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, reason: 'data-invalid-json' };
    }
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'data-not-object' };

  const content = data.content === null || data.content === undefined ? '' : String(data.content).trim();
  if (!content) return { ok: false, reason: 'missing-content' };

  const fromNodeId = nonEmptyString(payload.from_node_id ?? payload.fromNodeId);
  if (!fromNodeId) return { ok: false, reason: 'missing-from-node-id' };

  const fromNodeType =
    nonEmptyString(payload.from_node_type ?? payload.fromNodeType) ?? LIVIS_WIRE.nodeType;

  return {
    ok: true,
    task: {
      msgId,
      jobId,
      content,
      fromNodeId,
      fromNodeType,
      data,
      metadata,
      payload,
    },
  };
}

/**
 * Parse any inbound frame. Never throws.
 *
 * @param {unknown} raw string, Buffer, Uint8Array, or already-parsed object
 * @returns {{
 *   ok: true,
 *   kind: 'connected'|'message'|'cancel'|'ack'|'token_expiring'|'token_refreshed'|'error'|'unknown',
 *   task?: object, jobId?: string, refMsgId?: string, reason?: string, code?: string, type?: string
 * } | {ok: false, reason: string, type?: string, jobId?: string}}
 */
export function parseInbound(raw) {
  let text = raw;
  if (typeof text !== 'string') {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(text)) text = text.toString('utf8');
    else if (text instanceof Uint8Array) text = new TextDecoder().decode(text);
    else if (!isPlainObject(text)) return { ok: false, reason: 'unsupported-frame' };
  }

  let frame = text;
  if (typeof text === 'string') {
    try {
      frame = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'malformed-json' };
    }
  }
  if (!isPlainObject(frame)) return { ok: false, reason: 'frame-not-object' };
  const type = nonEmptyString(frame.type);
  if (!type) return { ok: false, reason: 'missing-type' };

  switch (type) {
    case 'connected':
      return { ok: true, kind: 'connected', type };

    case 'send_message': {
      const parsed = parseTaskEnvelope(frame);
      if (!parsed.ok) {
        const jobId = isPlainObject(frame.metadata)
          ? nonEmptyString(frame.metadata.job_id) ?? undefined
          : undefined;
        return { ok: false, reason: parsed.reason, type, jobId };
      }
      return { ok: true, kind: 'message', task: parsed.task, type };
    }

    case 'cancel_chat': {
      const jobId = isPlainObject(frame.metadata)
        ? nonEmptyString(frame.metadata.job_id)
        : null;
      if (!jobId) return { ok: false, reason: 'missing-job-id', type };
      return { ok: true, kind: 'cancel', jobId, type };
    }

    case 'ack_send_result': {
      const payload = isPlainObject(frame.payload) ? frame.payload : {};
      const metadata = isPlainObject(frame.metadata) ? frame.metadata : {};
      const refMsgId = nonEmptyString(payload.ref_msg_id) ?? undefined;
      const jobId = refMsgId ?? nonEmptyString(metadata.job_id) ?? undefined;
      if (!jobId) return { ok: false, reason: 'missing-job-id', type };
      return { ok: true, kind: 'ack', jobId, refMsgId, type };
    }

    case 'token_expiring':
      return { ok: true, kind: 'token_expiring', type };

    case 'token_refreshed':
      return { ok: true, kind: 'token_refreshed', type };

    case 'error': {
      const payload = isPlainObject(frame.payload) ? frame.payload : {};
      const reason =
        nonEmptyString(payload.reason) ??
        nonEmptyString(payload.message) ??
        nonEmptyString(payload.error) ??
        'unknown-relay-error';
      const code = nonEmptyString(payload.code) ?? undefined;
      return { ok: true, kind: 'error', reason, code, type };
    }

    default:
      return { ok: true, kind: 'unknown', type };
  }
}
