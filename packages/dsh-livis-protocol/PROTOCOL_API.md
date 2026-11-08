# Livis Protocol Library — API contract (P2 → P3)

`dsh-livis-protocol` is a standalone ESM library implementing the Livis relay
protocol that the official **Hermes v0.1.9** desktop client speaks. P3 integrates
it into the plugin; P3 should consume only the public API in this document.

- Location: `packages/dsh-livis-protocol` in the `dsh-livis` pnpm workspace
- Runtime: Node.js **>= 22**, ESM only (`"type": "module"`)
- Runtime dependencies: **none** (`fetch`, `WebSocket`, `FormData`, `Blob` are
  injected through config or taken from the Node globals)
- Dev-only dependency: `ws` (fake hub / tests; never imported by `src/index.js`)
- Verified against: official Hermes `v0.1.9` package (behavior baseline) and the
  Livis gateway wire notes. All tests run against a **local fake hub**; no real
  Livis/IDaaS network calls are made anywhere in this repository.

```js
import { createLivisClient } from 'dsh-livis-protocol';
```

---

## 1. Quick start

```js
const client = createLivisClient({
  stateDir: '/path/to/profile/livis-hermes', // required; client owns it 0700
  uploadRoot: '/path/to/profile/workdir',     // optional; required only for uploads
  environment: 'production',
  onHealthChange: (health) => pluginLog.debug('livis health', health),
});

client.on('message', async (task) => {
  // task: { msgId, jobId, content, fromNodeId, fromNodeType, data, metadata, payload }
  try {
    const files = task.data.files?.length
      ? await client.uploadFiles(task.data.files.map((f) => f.path), { jobId: task.jobId })
      : [];
    await client.sendResult(task.jobId, { text: 'final answer', files });
  } catch (error) {
    // sendResult already retried 4 times; the result stays cached for replay.
    client.retryResult(task.jobId).catch(() => {});
  }
});

client.on('cancel', ({ jobId }) => plugin.cancelJob(jobId));

await client.start();   // resolves after the gateway accepts the handshake
// ...
await client.stop();
```

First run has no refresh token: call `await client.login({ onCode })` once
(`onCode` receives `{ userCode, verificationUri, verificationUriComplete }`),
then `start()`. `start()` throws `LIVIS_AUTH_REQUIRED` when no credential exists.

---

## 2. `createLivisClient(config)` / `new LivisClient(config)`

Returns a `LivisClient`. Construction only validates config; no I/O happens
until `init()` / `start()` / `login()` / `upload*()` is called.

### 2.1 Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `stateDir` | string | **required** | Directory owned by the client. Created `0700`; contains `state.json` (`0600`). |
| `uploadRoot` | string | `null` | Files must resolve inside this directory to be uploaded. Required for `uploadFile(s)`. |
| `environment` | string | `'custom'` | Label copied into `health()`; e.g. `'production'`. |
| `websocketUrl` | string | `wss://livis-pc-kit-gateway.livis.com/api/v1/ws` | Relay WS endpoint. `?protocol_version=1` is appended automatically. |
| `httpUrl` | string | `https://livis-pc-kit-gateway.livis.com` | Base URL for file upload. |
| `idaasEndpoint` | string | `https://id.lixiang.com/api` | IDaaS base (`/aux`, `/token`, `/revoke`). |
| `clientId` | string | `6qxd1MLZhAtdWipnmXe1dd` | IDaaS client id. |
| `audience` | string | `rZgT0SETDNueMVAhfRN10` | IDaaS audience. |
| `scope` | string | `'super'` | Base scope; device code request sends `scope + ' offline_access'`. |
| `refreshToken` | string | `null` | Seed token; written through the secure store on `init()`. |
| `agentId` | string | `null` | Explicit identity; otherwise persisted, otherwise `hermes-<uuid4>`. |
| `deviceId` | string | `null` | Explicit identity; otherwise persisted, otherwise `pc_<uuid4>`. |
| `client` | string | `'hermes'` | Wire client label (connect + upload query). |
| `nodeType` | string | `'personl-device'` | Historic spelling required by the gateway. |
| `nodeName` | string | `'Hermes Agent'` | Connect payload `node_name`. |
| `nodeDescription` | string | `'personl-device Hermes Agent'` | Connect payload `node_desc`. |
| `agentIdPrefix` | string | `'hermes-'` | Used when generating an identity. |
| `deviceIdPrefix` | string | `'pc_'` | Official Hermes uses `pc_` (underscore), not `pc-`. Override only if the gateway requires it. |
| `protocolVersion` | string | `'1'` | `protocol_version` query value. |
| `heartbeatMs` | int ≥ 10 | `30000` | Heartbeat interval after handshake. |
| `connectTimeoutMs` | int ≥ 50 | `30000` | `start()` handshake deadline. |
| `ackTimeoutMs` | int ≥ 10 | `30000` | Wait for `ack_send_result` per attempt. |
| `maxResultAttempts` | 1..10 | `4` | Initial send + 3 retries, distinct `msg_id` each time. |
| `reconnectBaseMs` | int ≥ 10 | `1000` | Exponential backoff base. |
| `reconnectMaxMs` | int ≥ 10 | `60000` | Backoff cap (`>= reconnectBaseMs`). |
| `maxTokenRefreshFailures` | 1..10 | `3` | Consecutive refresh failures before closing the socket. |
| `completedResultCacheSize` | 1..1000 | `100` | Persisted results available for duplicate replay. |
| `autoAck` | boolean | `true` | Automatically send `ack_send_message` / `ack_cancel_chat`. |
| `replayCompletedResults` | boolean | `true` | Replay the cached result when a completed job is delivered again. |
| `logLevel` | `'debug'\|'info'\|'warn'\|'error'` | `'info'` | Logger threshold. |
| `logger` | object | console | `{debug,info,warn,error}`; wrapped so tokens are redacted. |
| `redactSecrets` | string[] | `[]` | Extra literals to redact from logs/errors. |
| `onHealthChange` | `(health) => void` | `null` | Called on every phase transition; exceptions are logged, never thrown. |

Testing/injection seams (not needed by P3 production code): `fetch` / `fetchImpl`,
`WebSocket` / `WebSocketImpl`, `now`, `sleep`, `random`, `stateStore`, `auth`.
These let tests point the client at a local fake hub and freeze the clock.

Validation failures throw `LivisConfigError` (`LIVIS_CONFIG_INVALID`) at
construction time. Plain `http:`/`ws:` endpoints are accepted only for
`localhost` / `127.0.0.1` / `[::1]`.

---

## 3. Lifecycle API

| Method | Returns | Notes |
| --- | --- | --- |
| `init()` | `Promise<this>` | Creates `stateDir` (0700), loads/persists identity + refresh token. Idempotent. |
| `login({ force, onCode, onPending, signal })` | `Promise<{ok, expiresAt, hasRefreshToken}>` | Runs the full IDaaS device flow. `onCode(code)` shows the user code; `onPending({status,error,intervalMs})` is optional progress. Resolves with **no token material**. |
| `setCredentials({ refreshToken, accessToken, expiresIn, agentId, deviceId })` | `Promise<{agentId, deviceId, hasRefreshToken}>` | Seed credentials/identity after an external login. Refresh token is persisted; access token stays in memory. |
| `logout({ signal })` | `Promise<{revoked, status}>` | Revokes the refresh token, clears local tokens, stops the client if running. |
| `tokenState()` | `Promise<{hasRefreshToken, hasAccessToken, accessTokenExpiresAt}>` | Secret-free. |
| `getIdentity()` | `{agentId, deviceId}` | Stable across reconnects/restarts (persisted). `null` before `init()`. |
| `start()` | `Promise<this>` | Connects; resolves after the gateway's `connected` frame. Rejects `LIVIS_AUTH_REQUIRED`, `LIVIS_CONNECT_TIMEOUT`, `LIVIS_STOPPED`. After the first success, reconnects automatically until `stop()`. Idempotent while connecting/connected. |
| `stop()` | `Promise<void>` | Idempotent. Clears heartbeat/backoff/start timers, closes the socket, rejects pending ack waits with `LIVIS_STOPPED`. The process does not stay alive because of client timers. |

`start()` after `stop()` is allowed: identity and tokens persist.

---

## 4. Events (`on(event, handler)` → unsubscribe)

Handlers run synchronously inside the inbound chain; exceptions are caught and
logged. Use `waitForEvent(event, { timeoutMs = 5000, predicate })` for awaits.

| Event | Payload |
| --- | --- |
| `connected` | `{ agentId, deviceId, at }` — emitted once per handshake (reconnect included). |
| `disconnected` | `{ code, reason, at }` — socket closed; auto-reconnect follows unless stopped. |
| `message` | The parsed task: `{ msgId, jobId, content, fromNodeId, fromNodeType, data, metadata, payload }`. `content` is trimmed. Only emitted for **new, non-canceled, not-yet-completed** jobs. |
| `cancel` | `{ jobId, at }` — `ack_cancel_chat` was sent (when `autoAck`). |
| `result-delivered` | `{ jobId, replay, attempts, at }` — gateway acknowledged `send_result`. |
| `token-refreshed` | `{ ok: true, at }` — local refresh + gateway `token_refreshed` (or successful refresh sent). |
| `error` | `{ message, code, retryable, at }` — redacted, secret-free. Transport errors are also followed by reconnect. |
| `state` | `{ phase, at, reason }` — phase transition; see §7. |

No token, refresh token, device code, or `Bearer` value is ever passed to an
event payload, log line, or `health()` snapshot.

---

## 5. Jobs and result delivery

### 5.1 Inbound job semantics (P3 must rely on these)

1. Every `send_message` is acknowledged with `ack_send_message` before any work
   (when `autoAck: true`; keep it true in production).
2. Duplicate `job_id` while active/result-pending: acknowledged, **no** second
   `message` event.
3. Duplicate `job_id` after completion: acknowledged, cached result replayed
   verbatim with a fresh `msg_id` (at-least-once; `result-delivered.replay=true`).
4. Duplicate after a process restart: the persisted completed result is loaded
   from `state.json` and replayed the same way.
5. Invalid frames (bad JSON, missing `from_node_id`, etc.) increment
   `health().counters.invalidFrames`, are logged, and are never acknowledged or
   executed. Malformed input cannot crash the client.
6. `cancel_chat` → `ack_cancel_chat`; a pending `sendResult` for that job is
   rejected with code `LIVIS_JOB_CANCELED`; later duplicates for a canceled job
   are ignored.

### 5.2 `sendResult(jobId, { text, files? })`

```js
const outcome = await client.sendResult(jobId, { text, files });
// { sent: true, duplicate: false, replay: false, attempts: 1, jobId }
```

- `text` is required and must be a string; `files` is an optional array of the
  exact objects returned by `uploadFile(s)`.
- Exactly **one final result per job** is the product rule. `sendResult` for a
  completed job does not send again; it logs and returns
  `{ sent: false, duplicate: true, attempts: 0, jobId }`.
- Concurrent calls for the same active job coalesce onto one promise.
- The payload is the official nested compact JSON string:
  `payload.data = JSON.stringify({text, files?})` (no spaces).
- The result is persisted to `state.json` **before** the first frame is sent, so
  a crash/disconnect can be recovered with `retryResult(jobId)` and duplicate
  deliveries replay identical bytes.
- Delivery waits for `ack_send_result` whose `payload.ref_msg_id` equals the
  `send_result.metadata.msg_id` (30 s default). On timeout it retries with a new
  `msg_id` (same payload) up to `maxResultAttempts` (4 = initial + 3 retries),
  then rejects with `LivisResultNotAckedError` (`LIVIS_RESULT_NOT_ACKED`,
  `error.jobId`, `error.attempts`); the result remains cached
  (`health().jobs.resultPending === 1`) for `retryResult`.
- The gateway treats `ack_send_result` as the only delivery success signal. There
  is no application-level "result received" message.

### 5.3 `retryResult(jobId)`

Re-delivers the cached/persisted result. Rejects `LIVIS_CONFIG_INVALID` if no
result is cached; rejects `LIVIS_NOT_CONNECTED` when offline. Returns the same
outcome shape as `sendResult`.

> P3 **must** dedupe work by `jobId`: the client guarantees one trigger per new
> delivery and one `sendResult` outcome, but the transport is at-least-once, so
> a trigger handler must be idempotent or keyed by `jobId`.

### 5.4 `ackMessage(jobId)` / `ackCancel(jobId)`

Manual acknowledgements for `autoAck: false`. Production should leave auto-ack on.

---

## 6. File upload

```js
const uploaded = await client.uploadFile('/abs/path/report.pdf', { jobId });
const all = await client.uploadFiles(['/abs/a.md', '/abs/b.pdf'], { jobId });
```

Returns the normalized object embedded in `send_result.files[]`:

```js
{
  name: 'report',                 // stem
  fileSuffix: 'pdf',              // lower-case extension
  objectKey: 'livis-bucket/...',  // gateway object key
  fileSize: 12345,
  fileType: 'application/pdf',
  file_path: '/files/...',        // derived from objectKey
  expiresAt: '...' | null
}
```

Constraints (`LIVIS_UPLOAD_REJECTED` before any network call):

- `uploadRoot` configured; the real path must stay inside it (symlinks resolved).
- Extension whitelist: `pdf, html, htm, md, markdown, doc, docx`.
- `0 < size <= 100 MiB`; at most 10 files per `uploadFiles` call.

Wire format: `POST {httpUrl}/api/v1/files/upload?client=hermes&job_id=…&msg_id=…&file_size=…&file_name=<stem>&file_suffix=…&file_type=…`, `Authorization: Bearer <access token>`, multipart field named `file` (filename = full name, part content-type = MIME). On HTTP 401/403 with a refresh token, the client refreshes once and retries. Other failures throw `LIVIS_UPLOAD_FAILED` (with `error.status`).

`uploadRoot` must be on the same filesystem path the plugin resolves from — pass
absolute paths, and reject any path outside it before calling.

---

## 7. `health()`

Secret-free snapshot, safe to log/return from a diagnostics endpoint:

```js
{
  phase: 'stopped' | 'idle' | 'connecting' | 'handshaking' | 'connected' | 'reconnecting',
  connected: boolean,             // phase === 'connected'
  handshakeAccepted: boolean,
  environment, client: 'hermes', nodeType: 'personl-device',
  agentId, deviceId,
  hasRefreshToken, hasAccessToken,
  websocketUrlConfigured: boolean, // true when the URL uses wss:
  heartbeat: { intervalMs, count, lastAt },
  lastConnectedAt, lastDisconnectedAt, lastInboundAt,
  lastError: { message, code, at } | null,   // redacted
  reconnectAttempts, reconnects,
  tokenRefreshFailures, tokenRefreshInFlight,
  pendingResultAcks,
  jobs: { tracked, active, resultPending, completed, canceled },
  counters: {
    inbound, acksSent, resultsSent, resultsAcked,
    duplicateMessages, droppedResults, replayedResults,
    invalidFrames, tokenRefreshes, reconnects
  },
  transitions: [{ phase, at, reason }],  // last 20
  sampledAt
}
```

Phase model: `stopped` → (`connecting` → `handshaking` → `connected`) ⇄
`reconnecting` → `stopped`. `token_expiring` is single-flight: concurrent
requests produce one refresh and one `token_refresh` frame, never a reconnect
storm. After `maxTokenRefreshFailures` consecutive failures the socket is closed
and normal backoff reconnects.

---

## 8. Errors

All errors extend `LivisError` with `{ code, retryable, details?, cause? }`.

| Code | Class | Typical cause |
| --- | --- | --- |
| `LIVIS_CONFIG_INVALID` | `LivisConfigError` | Bad config, missing `jobId`/`text`, no cached result. |
| `LIVIS_AUTH_REQUIRED` | `LivisAuthRequiredError` | `start()`/refresh without a refresh token. |
| `LIVIS_AUTH_FAILED` | `LivisAuthError` | Device login denied/expired, refresh 401 invalid_grant. |
| `LIVIS_HTTP_ERROR` | `LivisHttpError` | IDaaS HTTP failure; `error.status` set. |
| `LIVIS_PROTOCOL_INVALID` | `LivisProtocolError` | Internal parse/encode assertion. |
| `LIVIS_STATE_INVALID` / `LIVIS_STATE_INSECURE` | `LivisStateError` / `LivisStateSecurityError` | Corrupt/insecure `state.json`. |
| `LIVIS_CONNECTION_FAILED` | `LivisConnectionError` | Socket connect failure. |
| `LIVIS_CONNECT_TIMEOUT` | `LivisConnectTimeoutError` | No handshake within `connectTimeoutMs`. |
| `LIVIS_NOT_CONNECTED` / `LIVIS_DISCONNECTED` | `LivisNotConnectedError` / `LivisDisconnectedError` | Send while offline / socket closed mid-ack. |
| `LIVIS_RESULT_NOT_ACKED` | `LivisResultNotAckedError` | All `send_result` attempts went unacknowledged; `.jobId`, `.attempts`. |
| `LIVIS_JOB_CANCELED` | `LivisError` | `sendResult` rejected because `cancel_chat` arrived. |
| `LIVIS_UPLOAD_REJECTED` | `LivisUploadRejectedError` | Whitelist/size/path violation (no request made). |
| `LIVIS_UPLOAD_FAILED` | `LivisUploadError` | Upload transport/HTTP failure; `.status?`. |
| `LIVIS_STOPPED` | `LivisStoppedError` | Pending operation interrupted by `stop()`. |
| `LIVIS_TIMEOUT` | `LivisTimeoutError` | Generic timed wait (`waitForEvent`). |

---

## 9. Wire protocol (what the library sends)

### 9.1 Connect

URL: `{websocketUrl}?protocol_version=1`

```json
{
  "type": "connect",
  "metadata": {
    "msg_id": "<uuid4>", "job_id": "<uuid4>",
    "agent_id": "hermes-<uuid4>", "client": "hermes",
    "timestamp": 1730000000000
  },
  "payload": {
    "device_id": "pc_<uuid4>",
    "node_name": "Hermes Agent",
    "node_desc": "personl-device Hermes Agent",
    "client": "hermes",
    "token": "<access token>",
    "refresh_token": "<refresh token>"
  }
}
```

`metadata` intentionally has **no** `device_id` and `payload` has **no**
`nodeType` — this matches official Hermes v0.1.9 exactly. The gateway answers
`{"type":"connected"}`; only that frame makes `start()` resolve and starts the
heartbeat.

### 9.2 Heartbeat (30 s)

Common envelope: metadata `{msg_id, job_id, agent_id, device_id, client,
timestamp}`, payload `{nodeType:"personl-device"}`. First beat is sent after one
`heartbeatMs`; the timer is released on `stop()`.

### 9.3 Frames received

| Type | Handling |
| --- | --- |
| `connected` | handshake accepted / reconnect success. |
| `send_message` | parse + ack + emit `message` (dedupe per §5.1). |
| `cancel_chat` | ack + emit `cancel`, cancel pending result. |
| `ack_send_result` | resolve the pending delivery; `payload.ref_msg_id` is matched against the `send_result.metadata.msg_id`. |
| `token_expiring` | single-flight refresh, then send `token_refresh`. |
| `token_refreshed` | refresh acknowledged, reset failure counter. |
| `error` | emit `error`, close and reconnect. |
| anything else | logged at debug and ignored. |

Inbound `payload.data` may be a JSON **string** or an **object**; both parse.
`metadata.msg_id`, `metadata.job_id`, `payload.data`, a non-empty `content`, and
`payload.from_node_id` (or `fromNodeId`) are required; otherwise the frame is
invalid and ignored without side effects.

### 9.4 Result

`send_result` envelope (`metadata.msg_id` = per-attempt uuid) with
`payload: {data: "{\"text\":\"…\"}", nodeType: "personl-device"}`. The gateway
acks with `ack_send_result` and `payload.ref_msg_id` = that `msg_id`.

### 9.5 Token refresh

After `token_expiring`, POST IDaaS `/token` with
`grant_type=refresh_token` (single-flight), persist the **rotated**
`refresh_token`, then send:

```json
{ "type": "token_refresh", "metadata": { "...": "..." },
  "payload": { "token": "<new access>", "refresh_token": "<new refresh>", "nodeType": "personl-device" } }
```

A 401 clears the stored refresh token and fails with `LIVIS_AUTH_FAILED`; P3 then
runs the device login again. Tokens are never logged; the access token is never
persisted.

### 9.6 IDaaS device flow

- `POST {idaas}/aux` form `client_id`, `scope=super offline_access`,
  `audience`, `offline_access=true`, optional `prompt=login`.
- Poll `POST {idaas}/token` form `grant_type=urn:ietf:params:oauth:grant-type:device_code`,
  `device_code`, `client_id`. HTTP 428 or 400 `authorization_pending` = keep
  polling; 400 `slow_down` = interval += 5 s (cap 60 s); success requires both
  `access_token` and `refresh_token`; `expired_token`/`access_denied`/other 400
  = `LIVIS_AUTH_FAILED`; 429/5xx retried with backoff (max 3).
- `POST {idaas}/revoke` form `token=<refresh>`, `token_type_hint=refresh_token`,
  `client_id`; local tokens are cleared regardless of the response.

---

## 10. Persistence and security

`{stateDir}/state.json` (mode `0600`, dir `0700`):

```json
{
  "version": 1,
  "agentId": "hermes-…",
  "deviceId": "pc_…",
  "refreshToken": "…",
  "completedResults": [{ "jobId": "…", "result": "{\"text\":\"…\"}", "completedAt": 0 }],
  "updatedAt": 0
}
```

- Atomic write: `O_CREAT|O_EXCL` temp file `0600` → write → `fsync` →
  `rename` → `chmod 0600`; temp removed on failure.
- Reads reject symlinks, non-regular files, files with group/other permission
  bits, and foreign owners (`LIVIS_STATE_INSECURE`).
- Access tokens are memory-only; only the refresh token is persisted.
- Logs/errors/`health()` pass through a redactor that removes registered
  secrets, `Bearer …` values, JWT-shaped strings, and token-bearing JSON fields
  (`token`, `access_token`, `refresh_token`, `device_code`, …).

P3 owns the directory choice (inside its profile dir), must not copy
`state.json`, and should treat it as a credential.

---

## 11. Low-level modules (stable, optional)

```js
import { createStateStore } from 'dsh-livis-protocol/state';
import { createDeviceAuth } from 'dsh-livis-protocol/auth';
import { uploadFiles } from 'dsh-livis-protocol/upload';
import {
  connectEnvelope, envelope, parseInbound, parseTaskEnvelope, resultData,
} from 'dsh-livis-protocol/protocol';
import { createFakeHub } from 'dsh-livis-protocol/testing/fake-hub'; // tests only
```

These back the client and exist for P3 unit tests / protocol fixtures. `ws` is
required only by the fake hub, which is not reachable from the package root
export.

---

## 12. Verified gates → tests

| Evidence | Gate | Test file (run with `node --test test/*.test.js`) |
| --- | --- | --- |
| `V2-1` | G2-1 handshake/connect frame + heartbeat | `test/g2-1-handshake.test.js` |
| `V2-2` | G2-2 inbound JSON-string/object parsing + malformed frames | `test/g2-2-inbox.test.js` |
| `V2-3` | G2-3 result nested JSON, ack, retry 4×, replay, no duplicate | `test/g2-3-result.test.js` |
| `V2-4` | G2-4 IDaaS 428/slow_down/refresh/revoke + `state.json` 0600 | `test/g2-4-device-auth.test.js` |
| `V2-5` | G2-5 upload multipart fields + Bearer + whitelist | `test/g2-5-upload.test.js` |
| `V2-6` | G2-6 redaction + health transitions + reconnect + no timer leak | `test/g2-6-health-redaction.test.js` |

Run these commands from the **workspace root** (`dsh-livis/`), after
`pnpm install`:

```sh
pnpm test:protocol                          # 7 tests, local fake hub only
pnpm --filter dsh-livis-protocol run verify # V2-1.json … V2-6.json evidence
```

`verify` writes the evidence files into the superagent checkout's
`.artifacts/verify/p2/` directory (no secrets; that checkout stays clean because
`.artifacts/` is git-ignored). It defaults to the sibling
`dsh-superagent-prototype` checkout; set `SUPERAGENT_ROOT` or pass `--out <dir>`
when the checkout lives elsewhere. Running `node --test` from
`packages/dsh-livis-protocol` also works after a workspace install.

---

## 13. P3 integration checklist

1. Construct with `stateDir` inside the plugin profile; create `uploadRoot`.
2. First run: `login({ onCode })`, show `verificationUriComplete` to the user.
3. Register `message` and `cancel` handlers **before** `start()`.
4. Dedupe triggers by `jobId`; deliver exactly one `sendResult` per job.
5. On `LIVIS_RESULT_NOT_ACKED`, either call `retryResult` later or rely on
   duplicate replay; never call `sendResult` twice for the same job.
6. Map `cancel` to the trigger runtime; `cancel_chat` also rejects the pending
   `sendResult`.
7. Expose `health()` (minus nothing — it is secret-free) in diagnostics.
8. On `error`/`disconnected`, do not recreate the client; it reconnects itself.
9. On process shutdown call `stop()`; do not delete `state.json`.
10. Never log connect frames or token refresh payloads directly — use the
    injected logger/`redactor` from `resolveConfig` if custom logging is needed.
