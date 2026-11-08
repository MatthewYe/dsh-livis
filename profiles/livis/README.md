# livis DSH profile templates

These files are **templates**, not a live profile. They render an isolated DSH
profile named `dsh-profile-livis` that runs the `dsh-livis-source` plugin on port
`3083`, sets the `dsh-superagent` state root to `~/.dsh/state/livis`, and keeps
the plugin's own state under `~/.dsh/state/livis/livis-source`. The main profile
on `3082` is not touched when this profile is not running.

Nothing in this directory reads or writes `~/.dsh`. Rendering and installing the
profile is an explicit operator action.

## Placeholders

| Placeholder | Meaning | Default used in this repository |
| --- | --- | --- |
| `${SUPERAGENT_CHECKOUT}` | Absolute path to the `dsh-superagent-prototype` checkout | `$HOME/src/dsh-superagent-prototype` |
| `${DSH_LIVIS_REPO}` | Absolute path to this repository | `$HOME/src/dsh-livis` |
| `${LIVIS_PORT}` | Loopback HTTP/WebSocket port of the livis profile | `3083` |
| `${LIVIS_STATE_DIR}` | DSH state root passed to `dsh-superagent`'s `stateDir` (database, locks, worker shims). The plugin's own state is one level deeper, under `<root>/livis-source`. | `$HOME/.dsh/state/livis` |
| `${LIVIS_MODEL_PROVIDER}` | Provider for the Agent default model | `deepseek-account` |
| `${LIVIS_MODEL}` | Model for the Agent default model | `deepseek-flash` |

`${LIVIS_STATE_DIR}` is the DSH state root, not the plugin's state directory. By
default the plugin stores its own state under `${LIVIS_STATE_DIR}/livis-source`
(`$HOME/.dsh/state/livis/livis-source`), including `jobs.json` and
`client/state.json`. A custom `LIVIS_STATE_DIR` relocates the DSH state root; set
the plugin Source's `stateDir` to `${LIVIS_STATE_DIR}/livis-source` as well.

The templates contain no tokens, device identifiers, or rendered state.

## Render the profile

Prerequisites: a working DSH install, the `dsh-superagent-prototype` checkout, and this
repository installed (`pnpm install` at its root).

```bash
export SUPERAGENT_CHECKOUT="$HOME/src/dsh-superagent-prototype"
export DSH_LIVIS_REPO="$HOME/src/dsh-livis"
export LIVIS_PORT=3083
export LIVIS_STATE_DIR="$HOME/.dsh/state/livis"
export LIVIS_MODEL_PROVIDER=deepseek-account
export LIVIS_MODEL=deepseek-flash

mkdir -p "$HOME/.dsh/profiles/livis"
cp -a "$HOME/.dsh/profiles/livis" \
  "$HOME/.dsh/profiles/livis.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

envsubst < profiles/livis/package.json.template \
  > "$HOME/.dsh/profiles/livis/package.json"
envsubst < profiles/livis/cordis.patch.yml.template \
  > "$HOME/.dsh/profiles/livis/cordis.patch.yml"
```

`envsubst` is part of GNU gettext (`brew install gettext` on macOS). If it is
not available, use `sed` instead:

```bash
sed -e "s|\${SUPERAGENT_CHECKOUT}|$SUPERAGENT_CHECKOUT|g" \
    -e "s|\${DSH_LIVIS_REPO}|$DSH_LIVIS_REPO|g" \
    profiles/livis/package.json.template \
  > "$HOME/.dsh/profiles/livis/package.json"

sed -e "s|\${LIVIS_PORT}|$LIVIS_PORT|g" \
    -e "s|\${LIVIS_STATE_DIR}|$LIVIS_STATE_DIR|g" \
    -e "s|\${LIVIS_MODEL_PROVIDER}|$LIVIS_MODEL_PROVIDER|g" \
    -e "s|\${LIVIS_MODEL}|$LIVIS_MODEL|g" \
    profiles/livis/cordis.patch.yml.template \
  > "$HOME/.dsh/profiles/livis/cordis.patch.yml"
```

If you are recreating the profile directory from scratch, it also needs the
following two files. A live profile normally already has them.

`~/.dsh/profiles/livis/cordis.yml` — DSH builds the tree from bundles and then
applies `cordis.patch.yml`; the root entry list is intentionally empty:

```yaml
# dsh profile root — empty entry list; edit cordis.patch.yml instead.
[]
```

`~/.dsh/profiles/livis/pnpm-workspace.yaml` — required for `link:` dependencies:

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

## Install the rendered profile

```bash
cd "$HOME/.dsh/profiles/livis"
pnpm install
```

`package.json` links:

- `dsh-superagent` → `${SUPERAGENT_CHECKOUT}`
- `dsh-livis-source` → `${DSH_LIVIS_REPO}/packages/dsh-livis-source`

The plugin resolves `dsh-livis-protocol` through the workspace link already
created by `pnpm install` in this repository, so install the workspace before
the profile.

## Restart the livis profile

Do not restart the main profile. Only restart the isolated `livis` session:

```bash
tmux kill-session -t dsh-livis 2>/dev/null || true
mkdir -p "$SUPERAGENT_CHECKOUT/.artifacts"
tmux new-session -d -s dsh-livis -n server -c "$SUPERAGENT_CHECKOUT" \
  "umask 077; exec dsh --profile livis --no-open >> .artifacts/dsh-livis.log 2>&1"
```

If you do not use tmux, run the equivalent foreground command from the
superagent checkout with `umask 077`:

```bash
cd "$SUPERAGENT_CHECKOUT"
umask 077
dsh --profile livis --no-open
```

## Verify health

```bash
curl -s -H 'x-orchestrator-request: 1' \
  "http://127.0.0.1:${LIVIS_PORT}/orchestrator/api/state" | jq '.health.livis'
```

Expected: the plugin reports `ready` and a connected/authorized relay after
login. The main profile remains reachable on `3082` and has no `livis` entry.

## Authorize a device (manual, real login)

Only run this when the profile's health says authorization is required. The CLI
uses the IDaaS device flow; it never prints tokens. Follow the URL/code it
prints, approve the device in the 理想同学 App, then restart the livis session.

```bash
node "$DSH_LIVIS_REPO/packages/dsh-livis-source/scripts/livis-login.mjs"
node "$DSH_LIVIS_REPO/packages/dsh-livis-source/scripts/livis-login.mjs" --status
node "$DSH_LIVIS_REPO/packages/dsh-livis-source/scripts/livis-login.mjs" --logout
```

Local status/logout are safe and do not contact the relay. Real login is a
human step and is not performed by this repository.

## Security notes

- The rendered `package.json` and `cordis.patch.yml` contain machine-specific
  absolute paths: do not commit them.
- Token state is written under `${LIVIS_STATE_DIR}/livis-source` (default
  `~/.dsh/state/livis/livis-source`) with `0700` directory and `0600` file
  modes; `jobs.json` and `client/state.json` live there.
- Templates and this repository contain no credentials. Never paste tokens,
  device IDs, or authorization codes into a README, issue, or commit.
- The profile binds the webserver to `127.0.0.1` only.

## Rollback

```bash
tmux kill-session -t dsh-livis 2>/dev/null || true
node "$DSH_LIVIS_REPO/packages/dsh-livis-source/scripts/livis-login.mjs" --logout
```

Then restore the previous `package.json` / `cordis.patch.yml` from your backup,
or remove `~/.dsh/profiles/livis`. Removing the state directory is destructive
and is not required to disable the profile:

```bash
# Optional and destructive: deletes the device token, cached identity and jobs.
rm -rf "${LIVIS_STATE_DIR:-$HOME/.dsh/state/livis}/livis-source"
```

The main profile on `3082` does not need a restart unless it was stopped
independently.
