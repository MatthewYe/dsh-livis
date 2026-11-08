# dsh-livis-protocol

Standalone ESM implementation of the Livis relay protocol used by the
dsh-superagent plugin (P3). Behavior baseline: official **Hermes v0.1.9**; wire
protocol details were cross-checked against the MIT-licensed
[`dsh-livis-connector`](https://github.com/fyy99/dsh-livis-connector) reference.
This project's implementation is an independent rewrite; no source code was
copied from either project.

> **Workspace note.** This package lives at `packages/dsh-livis-protocol` in the
> `dsh-livis` pnpm workspace. Install and test from the workspace root; the
> commands below assume that root.

- **Full API contract for P3:** [`PROTOCOL_API.md`](./PROTOCOL_API.md)
- **Runtime:** Node.js >= 22, ESM, zero runtime dependencies
- **Tests:** local fake hub only; no real Livis/IDaaS calls, fake tokens only

```bash
pnpm install       # workspace root; dev-only: ws (fake hub server)
pnpm test:protocol # 6 gate files, 7 tests
pnpm --filter dsh-livis-protocol run verify  # V2-1..V2-6 evidence -> <superagent checkout>/.artifacts/verify/p2
```

`verify.mjs` defaults the superagent checkout to the sibling
`dsh-superagent-prototype` and the evidence directory to
`<checkout>/.artifacts/verify/p2`. Override them with `SUPERAGENT_ROOT` or the
`--out <dir>` flag when the checkout lives elsewhere.

Layout:

| Path | Purpose |
| --- | --- |
| `src/client.js` | `LivisClient` / `createLivisClient`: connect, heartbeat, reconnect, inbound dispatch, result delivery, uploads, `health()` |
| `src/protocol.js` | frame envelopes, compact `send_result` JSON, tolerant inbound parser |
| `src/auth.js` | IDaaS device flow, token refresh rotation, revoke |
| `src/state.js` | atomic `0600` `state.json`, identity + completed-result cache |
| `src/upload.js` | whitelisted multipart upload with Bearer auth |
| `src/redact.js` | token redaction for logs/errors/health |
| `src/testing/fake-hub.js` | local WS+HTTP gateway used by all tests |
| `test/g2-*.test.js` | G2-1 … G2-6 gate coverage |
| `scripts/verify.mjs` | gate runner + evidence generator (redacted, repo-clean check) |

Integration notes, wire frames, config defaults, error codes and the exact P3
surface are in [`PROTOCOL_API.md`](./PROTOCOL_API.md).
