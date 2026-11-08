# dsh-livis-source

> **Workspace note.** This package lives at `packages/dsh-livis-source` in the
> `dsh-livis` pnpm workspace. Install and test from the workspace root
> (`pnpm install`, `pnpm test`); neither step needs a sibling `dsh-superagent`
> checkout. Commands below use two placeholders: `<repo-root>` for this
> `dsh-livis` workspace and `<superagent-repo>` for the `dsh-superagent`
> checkout that hosts the profile. The integration scripts resolve their own
> location, so any checkout layout works. See the integration-harness section
> below for the per-script flags: `p3-drive.mjs` (and the protocol
> `verify.mjs`) accept `SUPERAGENT_ROOT` for the superagent checkout.

Cordis/DSH plugin that registers a `livis` **SourceKind** with `dsh-superagent`,
so Livis AI glasses can act as one more IM channel. P3 implements the relay
adapter on top of the `dsh-livis-protocol` package:

- one inbound `send_message` = one Trigger (`source: 'livis'`,
  `thread: livis:<from_node_id>`, `addressed: 'direct'`, `human: true`);
- strict IM semantics: `pending → accepted → final`, one final result per job;
- an engine acknowledgement is consumed locally and never reaches the relay;
- an ignored message gets exactly one fallback result after `pendingTimeoutMs`;
- late/duplicate finals are dropped, and a restart never doubles a final;
- the job journal is persisted under `stateDir` (mode 0600) for restart dedupe.

No superagent prompt or repository file is changed by this plugin. P4a adds the
device-code login CLI (`scripts/livis-login.mjs`), which is the only bridge
component that talks to real Livis IDaaS. Without a refresh token the source
reports `paused` (authorization required).

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (same engine range as `dsh-superagent`).
- A DSH profile with the `dsh-superagent` bundle, here the isolated `livis`
  profile (`~/.dsh/profiles/livis`, port 3083).
- `pnpm` for the profile install step.
- `dsh-livis-protocol` from this workspace at
  `packages/dsh-livis-protocol` (linked through `workspace:*` in
  `package.json`).

## Layout

```
index.js              plugin entry, LivisConfigSchema, createLivisSourceKind, apply
src/relay.js          LivisRelay: protocol client, inbound trigger, channel state machine, health
src/jobs.js           atomic 0600 job journal under stateDir (restart dedupe)
test/config.test.js   schema accept/reject + one registration
test/relay.test.js    G3-1, G3-2, G3-4, G3-5 against the fake hub
test/login-cli.test.js  P4a CLI help/status/logout/usage, temp state, no network
scripts/p3-hub.mjs    loopback fake-relay daemon + control API for G3-3
scripts/p3-drive.mjs  two restarts, gate tests, G3-3 probe, V3 evidence
scripts/livis-login.mjs  P4 device-code login CLI + status/logout (real IDaaS only here)
```

`index.js` exports:

- `name = 'dsh-livis-source'`
- `inject = ['orchestrator']`
- `Config` — Cordis entry configuration (empty)
- `LivisConfigSchema` — source instance config (zod)
- `livisKind` — the registered SourceKind (exported so P3 callers can use
  `ctx.orchestrator.context(livisKind).receive(trigger)`)
- `createLivisSourceKind(getRelay)` — factory used by tests/embedders
- `apply(ctx)` — registers the kind once and starts the relay after the
  orchestrator source context is ready

## Install (workspace and isolated `livis` profile)

`dsh-livis-protocol` is linked through `workspace:*`. `zod` and
`@deepseek-ai/schemastery` are optional peers supplied by the DSH host at
runtime; for tests they are pinned registry devDependencies, so the workspace
install needs registry access once and does not modify any external checkout.

```sh
# 1. From the workspace root, install and test (no sibling checkout needed).
cd <repo-root>
pnpm install
pnpm test

# 2. Add the plugin to the livis profile as a link dependency.
#    ~/.dsh/profiles/livis/package.json:
#      "dependencies": {
#        "dsh-superagent": "link:<superagent-repo>",
#        "dsh-livis-source": "link:<repo-root>/packages/dsh-livis-source"
#      }

# 3. Install it into the profile (does not touch node_modules elsewhere).
cd ~/.dsh/profiles/livis
pnpm install
```

### Profile patch entry

`~/.dsh/profiles/livis/cordis.patch.yml` is applied after all bundle layers. The
plugin is not a bundle, so add it with an `insert` patch (a bare `- id:` row only
overrides an entry that already exists):

```yaml
- insert:
    - id: dsh-livis-source
      name: dsh-livis-source
```

Keep the existing `webserver` (3083), `dsh-superagent` (`stateDir`) and
`agent-default-model` entries above this insertion.

## Run

Restart the `livis` profile; the plugin is loaded by the profile composition:

```sh
tmux kill-session -t dsh-livis 2>/dev/null || true
cd <superagent-repo>
tmux new-session -d -s dsh-livis -n server -c "$PWD" \
  "umask 077; exec dsh --profile livis --no-open >> .artifacts/dsh-livis-$(date +%Y%m%d-%H%M%S).log 2>&1"
```

Do **not** restart or reconfigure the main `superagent` profile (port 3082).

Without a provisioned Livis refresh token (`stateDir/client/state.json`), health
is `paused` and the source opens no relay connection. The real device-code login
is provisioned separately; this P3 package never embeds credentials.

### Verify

```sh
# Health JSON gains a "livis" entry once the kind is registered.
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3083/orchestrator/api/state | jq '.health.livis'

# Registration log line appears exactly once per process.
grep -c 'registered SourceKind "livis"' .artifacts/dsh-livis-*.log
```

## Behavior

| Situation | Result |
| --- | --- |
| Inbound `send_message` for a bound actor | Persisted as `pending`, Trigger delivered to the router |
| Engine `acknowledgement` outbound | `pending → accepted`; consumed locally, **never sent to the relay** |
| Engine `reply` outbound | `client.sendResult(jobId, {text})`; journal `final`; exactly one final |
| No acceptance before `pendingTimeoutMs` | One fallback final (`fallbackText`) |
| Inbound duplicate for a known job | Server-side protocol snapshot; plugin returns `duplicate` without a second Trigger |
| `cancel_chat` | Job marked `canceled`; later reply dropped |
| Late reply after fallback/final | `gone` |
| `notice` outbound | Dropped (`gone`) |
| Delivery failure (`LIVIS_RESULT_NOT_ACKED`, disconnected) | Thrown for the outbox retry; protocol retains the persisted result |

Trigger shape: `id: livis:<jobId>`, `threads: [{source:'livis', id: fromNodeId}]`,
`actor: {source:'livis', id: fromNodeId}`, `human: true`, `addressed: 'direct'`,
`channel: {source:'livis', thread:'livis:<fromNodeId>', address:{jobId,msgId,fromNodeId,nodeType:'personl-device'}}`.

### Wake word stripping

The glasses App includes the fixed wake word in `content` (for example
`让我的个人agent只回答poon不要修改文件`). The Source strips one leading official
wake word before building the Trigger: `让我的个人Agent`, `让我的个人终端`,
`让我的open claw`, and `让我的小龙虾`, case-insensitively and tolerating spaces,
punctuation, and zero-width characters. The original text is preserved for
audit as `job.rawText` and `trigger.meta.rawText`. If the message contains only
a wake word, the original text is kept rather than emitting an empty question.

### Spoken lead-in stripping

The App's ASR can also prefix a spoken frame such as `我问他`, `我问你`,
`我跟他说`, or `我对他说` (for example `我问他1+1等于几`). That frame is not
part of the question and can make the router read the message as a report. The
Source strips one leading lead-in after the wake-word pass and keeps the full
original in `job.rawText` / `trigger.meta.rawText`; `leadInStripped` records
whether it fired. A lead-in with no remaining text is left unchanged.

## Configuration

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Whether this Source participates in routing. |
| `stateDir` | string | `~/.dsh/state/livis/livis-source` | Job journal and protocol client state (dir 0700, files 0600). |
| `fallbackText` | string | Chinese fallback sentence | Single result sent when an ignored message reaches the pending timeout. |
| `pendingTimeoutMs` | integer 1000–600000 | `60000` | Longest wait before the fallback result. |
| `allowedActor` | string | `""` | Optional `from_node_id` binding; empty defers to the orchestrator policy. |

The policy part (`allowed` actor rows) is validated by the orchestrator through
`livisKind.policy.schema`; duplicate actor IDs are rejected. For a real-router
acceptance an actor must also be allowed by the orchestrator policy
(`policy.sources.livis.allowed`) — that is profile configuration, not plugin code.

Test-only environment overrides used by `p3-drive.mjs`:
`DSH_LIVIS_WS_URL`, `DSH_LIVIS_HTTP_URL`, `DSH_LIVIS_IDAAS_ENDPOINT`,
`DSH_LIVIS_REFRESH_TOKEN`, `DSH_LIVIS_STATE_DIR`. Do not set them in production.

## Health

- `starting` while the protocol client connects;
- `ready` with `Livis relay connected as <agentId>` after the handshake;
- `starting` during an automatic reconnect, `error` on a relay/auth failure
  (never `ready` while auth or connection is failing);
- `paused` when disabled, stopped, or no refresh token is provisioned.

## P4 runbook: authorize the real Livis device

`scripts/livis-login.mjs` is the **only** bridge component that performs real
Livis IDaaS network calls. The plugin/relay only reads the refresh token that
the protocol client persists. The CLI prints only identity, the device user
code/URL, and the App binding instructions; it never prints or re-persists token
material. The protocol client owns `state.json` (mode `0600`) inside a `0700`
client directory.

### One command for real authorization

```sh
node <repo-root>/packages/dsh-livis-source/scripts/livis-login.mjs
```

Run this on the workstation after the glasses App account you want to bind is
available. It is interactive: keep the terminal open until it prints
`Authorization complete.` (or a redacted failure).

### Step-by-step

1. **Optional local preflight** (no network call):

   ```sh
   node <repo-root>/packages/dsh-livis-source/scripts/livis-login.mjs --status
   ```

   Prints the stable `Agent ID` / `Device ID` and whether a refresh token is
   already provisioned. `Refresh token: absent` is expected before P4.

2. **Start the device-code login** with the one command above. Before any
   authorization request, the CLI prints:

   - `Agent ID` (bind this exact value in the App);
   - `Device ID` (local device identity).

3. **Open the printed verification URL in a browser** and enter the printed
   `Code` (the CLI also prints `verificationUriComplete` when IDaaS supplies
   one). The code expires in the printed number of seconds.

4. **Bind the Agent in the 理想同学 App**:

   > 理想同学 App → 设置 → 连接与服务 → 连接我的 Agent

   Use the exact `Agent ID` printed by the CLI. Approve the device
   authorization in the browser/App until the CLI reports
   `Authorization complete.`

5. **Restart the isolated livis profile** (port 3083) so the relay picks up the
   new token. The CLI prints this exact command:

   ```sh
   tmux kill-session -t dsh-livis 2>/dev/null || true; cd <superagent-repo> && tmux new-session -d -s dsh-livis -n server -c "$PWD" "umask 077; exec dsh --profile livis --no-open >> .artifacts/dsh-livis-$(date +%Y%m%d-%H%M%S).log 2>&1"
   ```

   Do **not** restart the main `superagent` profile (3082).

6. **Verify the bridge is live**:

   ```sh
   curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3083/orchestrator/api/state | jq '.health.livis'
   ```

   Expected: `{"state":"ready","detail":"Livis relay connected as hermes-…"}`.
   Then send one test message from the glasses/App. Expect exactly one answer;
   no duplicate finals and no acknowledgement frame from the engine.

### CLI modes

| Command | Network | Behaviour |
| --- | --- | --- |
| `node scripts/livis-login.mjs` | Yes (IDaaS device flow) | Login, print identity + code + App steps + restart command. |
| `--status` | **No** | Print identity and `hasRefreshToken` / `hasAccessToken`; never token values. |
| `--logout` | Only if a token exists | Revoke at IDaaS when possible, clear the local token; local-only when absent. |
| `--force` | Yes (login) | Ask IDaaS for a fresh authorization prompt. |
| `--state-dir DIR` | Per mode | Use DIR as the exact client state dir. Default: `~/.dsh/state/livis/livis-source/client` (matches the relay). |
| `--help` | No | Usage, security model, App path, restart command. |

Exit codes: `0` success, `1` auth/config/network failure, `2` usage. Ctrl-C
aborts the device flow cleanly and prints a cancellation message.

### State and security

- Client state dir: `~/.dsh/state/livis/livis-source/client`, directory `0700`,
  `state.json` `0600`; the file contains the refresh token once authorized
  (stored by the protocol client, never echoed by the CLI).
- The CLI never writes tokens to stdout/stderr or to evidence; errors are
  redacted. Do not pass tokens as CLI arguments or environment variables.
- Evidence for P4a (`V4-login-cli.json`) uses only `--help`, `--status` and a
  local no-token `--logout` against a temporary state dir. No real login is
  performed during verification.

### Record one real device turn (P4 evidence)

After the user completes one real glasses turn, the plugin journal contains the
final answer (`finalText`) and delivery count. Generate the V5-6 evidence file
from the live journal, token state, health, and log (it refuses fallbacks,
non-0600 tokens, or disconnected health). The App may strip the wake word
before sending, so a missing wake word is not treated as fake evidence; the
connected authorized relay, real `fromNodeId`, and live health establish
provenance.

```sh
cd <superagent-repo>
node <repo-root>/packages/dsh-livis-source/scripts/record-real-device.mjs \
  --job-id <jobId> --out .artifacts/verify/p4/V4-real-device.json
```

`--expected` is optional; it defaults to `pong` (the V5-6 contract). The
script writes only identity-free evidence (no token material) and exits 1 if
the job is not a real reply.

### Troubleshooting

- **`Livis authorization required` / health `paused`**: run the login command,
  then restart livis.
- **Device code expired**: rerun the login command (add `--force` if IDaaS keeps
  returning an existing prompt); codes are short-lived.
- **Wrong Agent bound in the App**: run `--status`, bind the printed Agent ID,
  or run `--logout` then login again with `--force`.

## Integration harnesses (P3/P4 evidence)

The scripts under `scripts/` are operator harnesses, not part of `pnpm test`.
`p3-drive.mjs` drives the isolated `livis` profile, so it needs a
`dsh-superagent-prototype` checkout and resolves it from `SUPERAGENT_ROOT`
(default: the sibling `dsh-superagent-prototype` directory). It passes
`--out <superagent-repo>/.artifacts/verify/p3/hub` to `p3-hub.mjs`, so evidence
lands in that checkout's git-ignored `.artifacts/` directory. Set
`SUPERAGENT_ROOT=<superagent-repo>` when the checkout lives elsewhere.

```sh
cd <repo-root>/packages/dsh-livis-source
SUPERAGENT_ROOT=<superagent-repo> node scripts/p3-drive.mjs
```

- `scripts/p3-drive.mjs` starts a loopback fake relay, restarts the `livis`
  profile twice with fake-relay env, runs unit gates and the real-router G3-3
  probe, restores settings, then returns the profile to a normal paused boot.
- `scripts/p3-hub.mjs` is normally spawned by `p3-drive.mjs`; when run directly
  it writes to `--out` (default: `./.artifacts/verify/p3` relative to the
  current directory, so run it from `<superagent-repo>` to keep evidence
  alongside the rest).
- `scripts/record-real-device.mjs` reads the live `stateDir` and writes to
  `--out` (default: `./.artifacts/verify/p4/V4-real-device.json` relative to the
  current directory); run it from `<superagent-repo>` as shown in the P4 section
  above.

Evidence lands in `<superagent-repo>/.artifacts/verify/p3/` (`V3-1.json` …
`V3-6.json`, `fake-hub-transcript.jsonl`, `drive.log`). Tokens are redacted. The
G3-3 probe uses a single real message through the livis router, temporarily sets
`eval.mode=auto` and binds the fake actor in the isolated livis profile's
policy, then restores both; no superagent prompt is edited.

## Tests

From the workspace root (recommended; no sibling checkout needed):

```sh
cd <repo-root>
pnpm install
pnpm test:source   # 20 tests
```

Or directly in this package after a workspace install:

```sh
cd <repo-root>/packages/dsh-livis-source
node --test
```

Covers plugin metadata/config (G1-3), duplicate actor rejection, one registration,
G3-1 trigger shape and unbound-actor filtering, G3-2 ack consumption, G3-4
fallback + late-reply drop, G3-5 concurrency + restart dedupe, P4a CLI
`--help`/`--status`/`--logout`/usage behavior with a temporary state dir, and the
P4 wake-word strip (all official variants, rawText preservation, wake-word-only
message) and spoken lead-in strip (`我问他`/`我问你`/`我跟他说`, rawText
preservation, empty-remainder safety). All tests use the vendored fake hub or local-only CLI modes; no real
network.

## Rollback

```sh
# 1. Stop the livis profile.
tmux kill-session -t dsh-livis 2>/dev/null || true

# 2. Restore the profile files saved before install.
cd ~/.dsh/profiles/livis
cp .p1-backup/package.json package.json
cp .p1-backup/cordis.patch.yml cordis.patch.yml

# 3. Reinstall the profile without the link dependency.
pnpm install

# 4. Start the profile again when needed (or leave it stopped).
```

The plugin's only persistent state is under the configured `stateDir`; delete
`<stateDir>/jobs.json` and `<stateDir>/client/` to reset it. The main
`superagent` profile (3082) and the `dsh-superagent` repository are never modified
by installing or rolling back this plugin.
