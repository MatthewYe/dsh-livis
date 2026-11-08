/**
 * Local fake Livis hub for tests: WebSocket relay endpoint, IDaaS device-flow
 * HTTP endpoints, and the file upload endpoint.
 *
 * It is deliberately boring: no timers that keep Node alive (all unref'd),
 * scripts are explicit, and everything it receives is recorded for assertions.
 * It never talks to the real Livis gateway.
 */

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const DEFAULT_DEVICE_CODE = {
  device_code: 'FAKE_DEVICE_CODE_1',
  user_code: 'FAKE-USER-CODE',
  verification_uri: 'https://verify.livis.test/device',
  verification_uri_complete: 'https://verify.livis.test/device?code=FAKE-USER-CODE',
  expires_in: 600,
  interval: 1,
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseForm(buffer) {
  const params = new URLSearchParams(buffer.toString('utf8'));
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

async function parseMultipart(buffer, contentType) {
  const response = new Response(buffer, { headers: { 'content-type': contentType } });
  const form = await response.formData();
  const fields = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, value });
    } else {
      const bytes = Buffer.from(await value.arrayBuffer());
      fields.push({
        name,
        fileName: value.name,
        contentType: value.type,
        size: value.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return fields;
}

function waitUntil(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = predicate();
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 5);
    timer.unref?.();
  });
}

function resolveScriptEntry(entry, successBodyFactory) {
  if (entry === undefined || entry === null || entry === 'success' || entry === 'ok') {
    return { status: 200, body: successBodyFactory() };
  }
  if (typeof entry === 'number') return { status: entry, body: { error: 'scripted_error' } };
  if (typeof entry === 'function') {
    const result = entry();
    return { status: result?.status ?? 200, body: result?.body ?? {} };
  }
  const status = entry.status ?? 200;
  if (status === 200 && entry.body === undefined) {
    return { status: 200, body: successBodyFactory() };
  }
  return { status, body: entry.body ?? {} };
}

/**
 * @param {{
 *   idaas?: {
 *     auxStatus?: number,
 *     auxBody?: object,
 *     deviceTokenScript?: any[],
 *     refreshScript?: any[],
 *     revokeScript?: any[],
 *   },
 *   relay?: {
 *     autoConnected?: boolean,
 *     connectedDelayMs?: number,
 *     autoTokenRefreshed?: boolean,
 *   },
 *   uploadResponse?: object|((ctx: object) => object),
 * }} [options]
 */
export async function createFakeHub(options = {}) {
  const state = {
    connections: [],
    frames: [],
    frameLog: [],
    rawFrameErrors: [],
    results: [],
    heartbeats: [],
    uploads: [],
    auxRequests: [],
    tokenRequests: [],
    revokeRequests: [],
    issued: [],
    accessSeq: 0,
    refreshSeq: 0,
    socketSeq: 0,
  };

  const deviceTokenScript = [...(options.idaas?.deviceTokenScript ?? [
    { status: 428, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    'success',
  ])];
  const refreshScript = [...(options.idaas?.refreshScript ?? [])];
  const revokeScript = [...(options.idaas?.revokeScript ?? [])];
  const auxStatus = options.idaas?.auxStatus ?? 200;
  const auxBody = options.idaas?.auxBody ?? DEFAULT_DEVICE_CODE;

  function issueTokens() {
    state.accessSeq += 1;
    state.refreshSeq += 1;
    const issued = {
      accessToken: `FAKE_ACCESS_TOKEN_${state.accessSeq}`,
      refreshToken: `FAKE_REFRESH_TOKEN_${state.refreshSeq}`,
      issuedAt: Date.now(),
    };
    state.issued.push(issued);
    return {
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'super',
    };
  }

  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  const hub = {
    urls: null,
    /** @type {any[]} parsed upstream frames in arrival order */
    frames: state.frames,
    frameLog: state.frameLog,
    connections: state.connections,
    results: state.results,
    heartbeats: state.heartbeats,
    uploads: state.uploads,
    idaas: {
      auxRequests: state.auxRequests,
      tokenRequests: state.tokenRequests,
      revokeRequests: state.revokeRequests,
      deviceTokenScript,
      refreshScript,
      revokeScript,
    },
    issued: state.issued,
    rawFrameErrors: state.rawFrameErrors,
    socketCount: () => sockets.size,
    /** Toggle result acknowledgements. */
    ackResults: options.ackResults ?? true,
    ackDelayMs: options.ackDelayMs ?? 0,
    autoConnected: options.relay?.autoConnected ?? true,
    connectedDelayMs: options.relay?.connectedDelayMs ?? 0,
    autoTokenRefreshed: options.relay?.autoTokenRefreshed ?? true,
    uploadStatus: options.uploadStatus ?? 200,
    uploadResponse: options.uploadResponse ?? null,

    lastIssuedAccessToken() {
      return state.issued.at(-1)?.accessToken ?? null;
    },
    lastIssuedRefreshToken() {
      return state.issued.at(-1)?.refreshToken ?? null;
    },

    framesOf(type) {
      return state.frames.filter((frame) => frame?.type === type);
    },

    async waitForFrame(type, opts = {}) {
      const { timeoutMs = 4_000, where = null, index = 0 } = opts;
      const list = () => state.frames.filter((f) => f?.type === type && (!where || where(f)));
      const seen = list().length;
      if (seen > index) return list()[index];
      const target = Math.max(seen, index + 1);
      await waitUntil(() => list().length >= target, timeoutMs, `relay frame "${type}"`);
      return list()[target - 1];
    },

    async waitForFrames(type, count, opts = {}) {
      const { timeoutMs = 4_000, where = null } = opts;
      const list = () => state.frames.filter((f) => f?.type === type && (!where || where(f)));
      await waitUntil(() => list().length >= count, timeoutMs, `${count} relay frame(s) "${type}"`);
      return list().slice(0, count);
    },

    async waitForResultFrames(count, opts = {}) {
      return hub.waitForFrames('send_result', count, opts);
    },

    async waitForConnection(count = 1, opts = {}) {
      const { timeoutMs = 4_000 } = opts;
      await waitUntil(() => state.connections.length >= count, timeoutMs, `${count} relay connection(s)`);
      return state.connections[count - 1];
    },

    send(frame) {
      const text = JSON.stringify(frame);
      for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(text);
    },

    sendRaw(text) {
      for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(text);
    },

    sendTo(socket, frame) {
      socket.send(JSON.stringify(frame));
    },

    dropConnections(code = 1011, reason = 'fake-hub-drop') {
      const pending = [];
      for (const socket of sockets) {
        pending.push(
          new Promise((resolve) => {
            socket.once('close', resolve);
            try {
              socket.close(code, reason);
            } catch {
              resolve();
            }
            setTimeout(resolve, 200).unref?.();
          }),
        );
      }
      return Promise.all(pending);
    },

    async close() {
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };

  function recordFrame(frame, conn) {
    state.frames.push(frame);
    state.frameLog.push({ frame, connectionId: conn.id, at: Date.now() });
    conn.frames.push(frame);
  }

  async function handleResult(frame, conn, socket) {
    state.results.push({ frame, at: Date.now(), connectionId: conn.id, acked: false });
    const acked = typeof hub.ackResults === 'function'
      ? await hub.ackResults(frame)
      : hub.ackResults;
    if (!acked) return;
    const sendAck = () => {
      if (socket.readyState !== socket.OPEN) return;
      const record = state.results.at(-1);
      if (record?.frame === frame) record.acked = true;
      socket.send(
        JSON.stringify({
          type: 'ack_send_result',
          metadata: {
            msg_id: randomUUID(),
            job_id: frame?.metadata?.job_id ?? randomUUID(),
            agent_id: frame?.metadata?.agent_id,
            device_id: frame?.metadata?.device_id,
            client: 'hermes',
            timestamp: Date.now(),
          },
          payload: { ref_msg_id: frame?.metadata?.msg_id, nodeType: 'personl-device' },
        }),
      );
    };
    if (hub.ackDelayMs > 0) setTimeout(sendAck, hub.ackDelayMs).unref?.();
    else sendAck();
  }

  wss.on('connection', (socket, req, url) => {
    state.socketSeq += 1;
    const conn = {
      id: state.socketSeq,
      socket,
      url: url.toString(),
      protocolVersion: url.searchParams.get('protocol_version'),
      connectedAt: Date.now(),
      connectFrame: null,
      frames: [],
      closedAt: null,
      closeCode: null,
    };
    state.connections.push(conn);
    sockets.add(socket);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        state.rawFrameErrors.push({ binary: true, size: data?.length ?? 0, at: Date.now() });
        return;
      }
      const text = data.toString('utf8');
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        state.rawFrameErrors.push({ text, at: Date.now() });
        return;
      }
      recordFrame(frame, conn);

      switch (frame?.type) {
        case 'connect':
          conn.connectFrame = frame;
          if (hub.autoConnected) {
            const sendConnected = () => {
              if (socket.readyState !== socket.OPEN) return;
              socket.send(JSON.stringify({ type: 'connected' }));
            };
            if (hub.connectedDelayMs > 0) setTimeout(sendConnected, hub.connectedDelayMs).unref?.();
            else sendConnected();
          }
          break;
        case 'heartbeat':
          state.heartbeats.push({ frame, at: Date.now(), connectionId: conn.id });
          break;
        case 'send_result':
          void handleResult(frame, conn, socket);
          break;
        case 'token_refresh':
          if (hub.autoTokenRefreshed) {
            setTimeout(() => {
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: 'token_refreshed' }));
              }
            }, 0).unref?.();
          }
          break;
        default:
          break;
      }
    });

    socket.on('close', (code, reason) => {
      conn.closedAt = Date.now();
      conn.closeCode = code;
      conn.closeReason = reason ? reason.toString() : '';
      sockets.delete(socket);
    });

    socket.on('error', () => {
      // Client disconnects are expected in tests.
    });
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'POST' && path === '/idaas/api/aux') {
        const form = parseForm(await readBody(req));
        state.auxRequests.push({ form, at: Date.now() });
        sendJson(res, auxStatus, auxBody);
        return;
      }

      if (req.method === 'POST' && path === '/idaas/api/token') {
        const form = parseForm(await readBody(req));
        state.tokenRequests.push({ form, grantType: form.grant_type, at: Date.now() });
        if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          const entry = deviceTokenScript.length > 0 ? deviceTokenScript.shift() : 'success';
          const { status, body } = resolveScriptEntry(entry, () => issueTokens());
          sendJson(res, status, body);
          return;
        }
        if (form.grant_type === 'refresh_token') {
          if (!form.refresh_token) {
            sendJson(res, 400, { error: 'invalid_request' });
            return;
          }
          const entry = refreshScript.length > 0 ? refreshScript.shift() : 'success';
          const { status, body } = resolveScriptEntry(entry, () => issueTokens());
          sendJson(res, status, body);
          return;
        }
        sendJson(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      if (req.method === 'POST' && path === '/idaas/api/revoke') {
        const form = parseForm(await readBody(req));
        state.revokeRequests.push({ form, at: Date.now() });
        const entry = revokeScript.length > 0 ? revokeScript.shift() : { status: 200, body: {} };
        const { status, body } = resolveScriptEntry(entry, () => ({}));
        sendJson(res, status, body);
        return;
      }

      if (req.method === 'POST' && path === '/api/v1/files/upload') {
        const buffer = await readBody(req);
        const query = {};
        for (const [key, value] of url.searchParams.entries()) query[key] = value;
        const authorization = req.headers.authorization ?? '';
        const contentType = req.headers['content-type'] ?? '';
        const record = {
          query,
          authorizationPresent: authorization.startsWith('Bearer '),
          bearerToken: authorization.startsWith('Bearer ') ? authorization.slice(7) : null,
          contentType,
          contentLength: buffer.length,
          fields: [],
          at: Date.now(),
        };
        if (hub.uploadStatus !== 200) {
          state.uploads.push(record);
          sendJson(res, hub.uploadStatus, { error: 'upload_failed' });
          return;
        }
        try {
          record.fields = await parseMultipart(buffer, contentType);
        } catch (error) {
          record.parseError = String(error?.message ?? error);
        }
        state.uploads.push(record);
        const file = record.fields.find((field) => field.name === 'file');
        const defaultResponse = {
          objectKey: `files/2026/11/${query.job_id ?? 'job'}/${file?.fileName ?? 'file.bin'}`,
          fileInfo: {
            fileSize: file?.size ?? 0,
            fileType: file?.contentType ?? 'application/octet-stream',
          },
          expiresAt: '2026-11-08T02:00:00.000Z',
        };
        const response =
          typeof hub.uploadResponse === 'function'
            ? hub.uploadResponse({ query, file, record })
            : hub.uploadResponse ?? defaultResponse;
        sendJson(res, 200, response);
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    })().catch((error) => {
      sendJson(res, 500, { error: 'fake_hub_error', message: String(error?.message ?? error) });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  hub.urls = {
    ws: `ws://127.0.0.1:${address.port}/api/v1/ws`,
    http: base,
    idaas: `${base}/idaas/api`,
    port: address.port,
  };
  return hub;
}
