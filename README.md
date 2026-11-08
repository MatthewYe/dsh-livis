# dsh-livis

> **Unofficial community project.** This repository is not affiliated with,
> endorsed by, or supported by 理想汽车 (Li Auto). "Livis", "理想同学", and
> related marks belong to their respective owners. The vendor protocol is
> undocumented and may change or be blocked at any time — use at your own risk.
> See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

A pnpm workspace for an unofficial 理想 Livis (livis-pc-kit) IM channel for
[`dsh-superagent`](https://github.com/deepseek-ai/dsh-superagent-prototype). It contains
the standalone relay protocol library, the glasses `SourceKind` plugin, and
templates for an isolated DSH profile.

The code is a behavior-preserving migration of the earlier prototype checkouts
`dsh-livis-protocol` and `dsh-livis-source`. Public exports and test behavior are
unchanged: **7 protocol tests** and **20 plugin tests** pass from this workspace
on a fresh clone.

## Architecture

```text
Livis glasses
    ⇅  voice / display (paired through the 理想同学 App)
Livis cloud relay
    ⇅  WSS  wss://livis-pc-kit-gateway.livis.com/api/v1/ws
dsh-livis-source  (SourceKind plugin, inside DSH)
    ⇅
dsh-superagent orchestrator  →  router / worker  →  one final answer
```

The bridge is strict IM: every inbound voice message becomes one Trigger for the
configured Agent, a job produces exactly one final result, and that result is
delivered to the relay once. The plugin never sends an acknowledgement to the
glasses and ignores router fallbacks. Jobs are keyed by the inbound node and
tagged with the thread `livis:<from_node_id>`.

## Repository layout

```text
dsh-livis/
├── packages/
│   ├── dsh-livis-protocol/   # zero-runtime-dependency ESM protocol library
│   │   ├── src/              # auth, client, config, protocol, state, upload...
│   │   ├── test/             # G2 gate tests (7 tests, local fake hub only)
│   │   ├── scripts/verify.mjs
│   │   ├── PROTOCOL_API.md
│   │   └── README.md
│   └── dsh-livis-source/     # DSH SourceKind plugin
│       ├── index.js
│       ├── src/              # jobs.js, relay.js
│       ├── test/             # config, login CLI, relay tests (20 tests)
│       ├── scripts/          # operator/integration harnesses
│       └── README.md
├── profiles/livis/           # templates only — no live profile, no secrets
│   ├── package.json.template
│   ├── cordis.patch.yml.template
│   └── README.md
├── .github/workflows/test.yml
├── LICENSE
├── NOTICE
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── .gitignore
```

## Package boundaries

### `packages/dsh-livis-protocol`

Standalone implementation of the Livis relay protocol spoken by the official
Hermes `v0.1.9` desktop client: IDaaS device flow and token rotation, WSS relay
client, inbound frame parsing, result delivery, whitelisted file upload, atomic
`0600` state, and token redaction.

- **Runtime dependencies: none.** `fetch`, `WebSocket`, `FormData`, and `Blob`
  are injected or taken from Node globals.
- `ws` is a **devDependency** used only by the local fake hub in tests.
- Public entry points: `.`, `./protocol`, `./auth`, `./upload`, `./state`,
  `./testing/fake-hub`, `./package.json`.

The API contract is in [`PROTOCOL_API.md`](packages/dsh-livis-protocol/PROTOCOL_API.md).

### `packages/dsh-livis-source`

The DSH plugin. It registers the `livis` SourceKind, validates the profile
configuration, receives relay messages, creates Triggers, persists jobs, and
delivers exactly one final result per job.

- Depends on `dsh-livis-protocol` through `workspace:*`.
- `@deepseek-ai/schemastery` and `zod` are **optional peerDependencies**
  supplied by the DSH host, so the package can be linked into a host that
  already provides them without installing a second copy.
- They are also listed as **devDependencies** with exact registry versions so
  the test suite runs from a fresh clone with no sibling checkout.

## Requirements

- Node.js `^22.19.0` or `>=24.0.0` (tested with Node.js 22.22.1 and 25.4.0).
- pnpm `>= 11.7.0` (tested with pnpm 12.8.1). No pnpm version is pinned in the
  workspace manifest; CI pins pnpm 12.8.1.

## Install and test

From a fresh clone — no sibling superagent checkout is needed:

```bash
git clone https://github.com/MatthewYe/dsh-livis.git
cd dsh-livis
pnpm install
pnpm test              # protocol then source
pnpm test:protocol     # 7 tests
pnpm test:source       # 20 tests
```

Both suites must exit `0`: **7 passing** protocol tests and **20 passing**
source tests, with 0 failures. The reporter layout depends on the Node.js
version (the `spec` reporter prints `ℹ tests 7`, the TAP reporter prints
`# tests 7`).

Tests use a local fake relay hub and fake tokens only. They do not contact
Livis, IDaaS, or the real device.

## Dependency strategy

| Package | `dependencies` | `devDependencies` | `peerDependencies` |
| --- | --- | --- | --- |
| `dsh-livis-protocol` | none | `ws@^8.18.0` | none |
| `dsh-livis-source` | `dsh-livis-protocol@workspace:*` | `@deepseek-ai/schemastery@3.18.5-alpha.1`, `zod@4.4.3` | same two packages, version `*`, both optional |

The devDependencies are pinned to the versions the DSH host currently ships, so
the workspace installs from the registry and the tests resolve the peers exactly
as the host would. They do not modify any external checkout.

Peer versions are intentionally `*`: a narrower range would reject the host's
prerelease builds. Optional peers keep pnpm from installing a duplicate copy in
the host profile.

There is exactly one lockfile for the workspace: `pnpm-lock.yaml`. The old
per-package lockfiles were intentionally excluded.

## Profile templates

`profiles/livis/` contains templates only. Nothing under `~/.dsh` is read or
written by installing or testing this repository. Rendering and installing a
profile is a separate operator action. To render the profile on a machine,
choose your own checkout locations for the two repositories:

```bash
export SUPERAGENT_CHECKOUT="$HOME/src/dsh-superagent-prototype"
export DSH_LIVIS_REPO="$HOME/src/dsh-livis"
export LIVIS_PORT=3083
export LIVIS_STATE_DIR="$HOME/.dsh/state/livis"
export LIVIS_MODEL_PROVIDER=deepseek-account
export LIVIS_MODEL=deepseek-flash

mkdir -p "$HOME/.dsh/profiles/livis"
envsubst < profiles/livis/package.json.template \
  > "$HOME/.dsh/profiles/livis/package.json"
envsubst < profiles/livis/cordis.patch.yml.template \
  > "$HOME/.dsh/profiles/livis/cordis.patch.yml"
```

Then install the profile and restart it. See
[`profiles/livis/README.md`](profiles/livis/README.md) for the full sequence,
`envsubst`-free substitution, health checks, and rollback.

The rendered profile uses port `3083` and the DSH state root
`~/.dsh/state/livis` by default, so it does not share the main DSH profile's
port or state directory on `3082`. The plugin's own state is nested at
`~/.dsh/state/livis/livis-source`. The templates intentionally contain no
tokens, no device identifiers, and no rendered state.

**Cutover and rollback.** Rendering the templates and running `pnpm install` in
`~/.dsh/profiles/livis` *does* modify the live livis profile directory — that is
the point of the cutover. Back up `~/.dsh/profiles/livis` first (the templates
README shows how), and restore it to roll back. The main profile on `3082` is
only affected if you restart or reconfigure it yourself.

## Verification summary

The local P5 gate passed on 2026-11-08 against a clean `dsh-superagent` baseline
and this workspace:

- Gates **V0–V5** passed: repository/prompt integrity, main profile health,
  isolated livis profile health and plugin linkage, redacted evidence scan with
  no token material, and the test suites.
- **7 protocol tests** and **20 plugin tests** pass, with 0 failures.
- **One real-device round trip** through authorized glasses: one spoken prompt,
  exactly one final answer, exactly one delivery, and zero duplicate results.
- **21 redacted evidence files** were collected across V0–V3 and the login CLI
  check.

Raw evidence lives outside this repository, in the superagent checkout's
git-ignored `.artifacts/verify/` directory. It is not committed here.

## Security and compatibility notes

- This is an unofficial client for an undocumented vendor protocol. Behavior is
  based on the official Hermes adapter `v0.1.9` and may break if the vendor
  changes the gateway, IDaaS endpoints, or authorization rules.
- No tokens, JWTs, cookies, device identifiers, or live state files are tracked.
  Tests use fake credentials and a local fake hub.
- Live credentials are stored by the plugin under its own `stateDir`, which
  defaults to `~/.dsh/state/livis/livis-source` — one level below the default
  `dsh-superagent` state root — with `0700`/`0600` permissions. A custom
  `LIVIS_STATE_DIR` relocates the DSH state root; point the plugin's `stateDir`
  at `${LIVIS_STATE_DIR}/livis-source`. Do not commit that directory.
- The worker runs with `danger-full-access` in the superagent prototype; the
  plugin does not add a sandbox or an approval boundary.
- Read [`NOTICE`](NOTICE) for trademark and protocol-provenance details.

## Rollback

Stopping and removing the livis profile does not touch the main profile on
`3082`:

```bash
tmux kill-session -t dsh-livis 2>/dev/null || true
# optional: revoke the device token and clear local token state
node packages/dsh-livis-source/scripts/livis-login.mjs --logout
# restore the previous profile files from your backup, or remove the profile dir
```

Then restart the main profile only if you stopped it, and confirm
`http://127.0.0.1:3082/` is healthy. The plugin has no effect on `3082` when the
livis profile is not running.

## Known limitations

- No streaming: results are delivered once as a final message.
- No approval UI for worker tool calls.
- ASR and wake-word behavior varies by device/firmware; the wake-word stripper
  only handles the documented variants.
- One Livis Agent slot per profile.
- File upload is outbound-only and unused in the MVP.
- The worker runs with full host access (`danger-full-access`).
- `packages/dsh-livis-source/scripts/` contains prototype integration harnesses
  (`p3-hub`, `p3-drive`, `livis-login`, `record-real-device`), and
  `packages/dsh-livis-protocol/scripts/verify.mjs` writes P2 evidence. They are
  **not** run by `pnpm test`; the test suites are self-contained. Path handling
  differs per script and the source-package READMEs are authoritative:
  `p3-drive.mjs` resolves the plugin/protocol from its own location and the
  superagent checkout from `SUPERAGENT_ROOT` (default: a sibling checkout); the
  protocol `verify.mjs` accepts `SUPERAGENT_ROOT` or `--out` for its evidence
  directory; `p3-hub.mjs` takes `--out` (default `./.artifacts/verify/p3` under
  the current directory); `record-real-device.mjs` takes `--state-root`
  (default `~/.dsh/state/livis/livis-source`) and `--out` (default
  `./.artifacts/verify/p4/V4-real-device.json`). `livis-login.mjs` takes
  `--state-dir`, and its `SUPERAGENT_ROOT` only affects the restart command it
  prints.

## Provenance

Migrated from the prototype checkouts `dsh-livis-protocol` and `dsh-livis-source`.
Excluded from the migration: `node_modules`, the per-package lockfiles,
package-local `.gitignore` files, and local artifacts. The package `README.md`
files are retained as detailed documentation; this root README is authoritative
for the workspace.

## License

MIT — see [`LICENSE`](LICENSE). Trademark, provenance, and compatibility notes
are in [`NOTICE`](NOTICE).
