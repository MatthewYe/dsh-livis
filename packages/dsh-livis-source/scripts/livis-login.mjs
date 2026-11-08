#!/usr/bin/env node
/**
 * Livis device-code login CLI (P4a).
 *
 * This is the ONLY code path in the bridge that performs real Livis IDaaS
 * network calls. The relay/plugin only reads the refresh token the protocol
 * client stores (state.json mode 0600). The CLI never prints token material.
 *
 * Usage:
 *   node scripts/livis-login.mjs                 # device-code login
 *   node scripts/livis-login.mjs --status        # local status only, no network
 *   node scripts/livis-login.mjs --logout        # revoke + clear local token
 *   node scripts/livis-login.mjs --force         # force a fresh login prompt
 *   node scripts/livis-login.mjs --state-dir DIR # exact client state dir
 *
 * Exit codes: 0 success, 1 auth/config/network failure, 2 usage.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createLivisClient } from 'dsh-livis-protocol';

const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'state', 'livis', 'livis-source', 'client');
const APP_PATH = '理想同学 App → 设置 → 连接与服务 → 连接我的 Agent';
// The restart command runs from the sibling dsh-superagent checkout. Resolve it
// relative to this script by default; SUPERAGENT_ROOT overrides for other layouts.
const SUPERAGENT_ROOT = process.env.SUPERAGENT_ROOT
  || resolve(fileURLToPath(new URL('../../../../dsh-superagent-prototype', import.meta.url)));
const RESTART_COMMAND =
  'tmux kill-session -t dsh-livis 2>/dev/null || true; ' +
  `cd ${SUPERAGENT_ROOT} && ` +
  'tmux new-session -d -s dsh-livis -n server -c "$PWD" ' +
  '"umask 077; exec dsh --profile livis --no-open >> .artifacts/dsh-livis-$(date +%Y%m%d-%H%M%S).log 2>&1"';
const HEALTH_COMMAND =
  "curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3083/orchestrator/api/state | jq '.health.livis'";
const HELP_TEXT = `Livis device-code login for the dsh-superagent bridge

Usage:
  node scripts/livis-login.mjs [--status | --logout] [--force] [--state-dir DIR]
  node scripts/livis-login.mjs --help

Modes:
  (default)       Run the Livis IDaaS device-code login.
                  Prints Agent ID/Device ID first, then the user code + URL,
                  then the App binding steps and the livis restart command.
  --status        Local-only: print identity and whether tokens are present.
                  Makes NO network call and never prints token material.
  --logout        Revoke the refresh token at Livis IDaaS (when one exists)
                  and clear the local token. Safe/local-only when absent.
  --force         With login: ask IDaaS for a fresh authorization prompt.
  --state-dir DIR Use DIR as the exact client state directory.
                  Default: ${DEFAULT_STATE_DIR}

Security:
  The protocol client writes state.json (mode 0600) in the state directory
  (directory mode 0700). Tokens are never printed by this CLI. Only the
  hidden protocol client stores them. This is the only bridge component that
  talks to Livis IDaaS.

Exit codes:
  0 success   1 auth/config/network failure   2 usage

Real authorization (one command, from the workspace root):
  node packages/dsh-livis-source/scripts/livis-login.mjs

App binding path:
  ${APP_PATH}

Restart the isolated livis profile (3083) after authorization:
  ${RESTART_COMMAND}
`;

function usageError(message) {
  process.stderr.write(`livis-login: ${message}\n`);
  process.stderr.write('Try: node scripts/livis-login.mjs --help\n');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: 'login', force: false, stateDir: null, help: false };
  let selected = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--status' || arg === '--logout') {
      const mode = arg === '--status' ? 'status' : 'logout';
      if (selected && selected !== mode) usageError('choose only one of --status or --logout');
      selected = mode;
      options.mode = mode;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--state-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) usageError('--state-dir requires a directory value');
      options.stateDir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) usageError(`unknown option: ${arg}`);
    usageError(`unexpected argument: ${arg}`);
  }
  if (options.help && (selected || options.force || options.stateDir)) {
    usageError('--help cannot be combined with another option');
  }
  if (options.force && options.mode !== 'login') usageError('--force is only valid for login');
  return options;
}

function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

/** Redact anything token-shaped before writing to stderr/stdout. */
function redact(value) {
  return String(value ?? '')
    .replace(/([?&](?:token|access_token|refresh_token|device_code|id_token)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(?:FAKE_[A-Z0-9_]*(?:TOKEN|CODE)|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '<redacted>');
}

function printIdentity(agentId, deviceId) {
  process.stdout.write(`Agent ID:  ${agentId}\n`);
  process.stdout.write(`Device ID: ${deviceId}\n`);
}

function printBindingSteps(agentId) {
  process.stdout.write('\nApp binding:\n');
  process.stdout.write(`  ${APP_PATH}\n`);
  process.stdout.write(`  Bind Agent ID: ${agentId}\n`);
}

function printRestartSteps() {
  process.stdout.write('\nNext steps:\n');
  process.stdout.write(`  1. Confirm Agent ID is bound in the App (${APP_PATH}).\n`);
  process.stdout.write('  2. Restart the isolated livis profile (port 3083):\n');
  process.stdout.write(`     ${RESTART_COMMAND}\n`);
  process.stdout.write('  3. Verify the relay is connected:\n');
  process.stdout.write(`     ${HEALTH_COMMAND}\n`);
  process.stdout.write('     Expected: {"state":"ready","detail":"Livis relay connected as hermes-..."}\n');
  process.stdout.write('  4. Send one test message from the glasses; expect exactly one answer.\n');
}

async function runStatus(client, stateDir) {
  await client.init();
  const identity = client.getIdentity();
  const tokens = await client.tokenState();
  process.stdout.write(`Client state directory: ${stateDir}\n`);
  printIdentity(identity.agentId, identity.deviceId);
  process.stdout.write(`Refresh token: ${tokens.hasRefreshToken ? 'present' : 'absent'}\n`);
  process.stdout.write(`Access token (cached): ${tokens.hasAccessToken ? 'present' : 'absent'}\n`);
  if (tokens.hasRefreshToken && tokens.accessTokenExpiresAt) {
    process.stdout.write(`Access token expires at: ${new Date(tokens.accessTokenExpiresAt).toISOString()}\n`);
  }
  process.stdout.write('Network calls: none (local status only)\n');
  if (tokens.hasRefreshToken) {
    process.stdout.write('Relay: credentials provisioned; restart livis if the plugin was started before login.\n');
  } else {
    process.stdout.write('Relay: not authorized; run this CLI without --status to bind the device.\n');
  }
}

async function runLogout(client, stateDir) {
  await client.init();
  const identity = client.getIdentity();
  process.stdout.write(`Client state directory: ${stateDir}\n`);
  printIdentity(identity.agentId, identity.deviceId);
  const result = await client.logout();
  process.stdout.write(`Remote revoke: ${result.revoked ? 'ok' : 'not applicable'}${result.status ? ` (HTTP ${result.status})` : ''}\n`);
  process.stdout.write('Local refresh token: cleared\n');
  process.stdout.write('Restart livis to return the source to paused, or run login again.\n');
}

async function runLogin(client, stateDir, force) {
  await client.init();
  const identity = client.getIdentity();
  process.stdout.write(`Client state directory: ${stateDir}\n`);
  printIdentity(identity.agentId, identity.deviceId);
  process.stdout.write('\nStarting Livis device-code authorization (no token is printed).\n');

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      process.stderr.write('\nAborted.\n');
      process.exit(1);
    }
    interrupted = true;
    process.stderr.write('\nCancelling device authorization...\n');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  let lastProgress = '';
  try {
    const result = await client.login({
      force,
      signal: controller.signal,
      onCode: (code) => {
        process.stdout.write('\nAuthorize this device in a browser:\n');
        if (code.verificationUriComplete) {
          process.stdout.write(`  Open: ${code.verificationUriComplete}\n`);
        }
        process.stdout.write(`  URL:  ${code.verificationUri}\n`);
        process.stdout.write(`  Code: ${code.userCode}\n`);
        process.stdout.write(`  Expires in: ${Math.round(code.expiresIn)} seconds\n`);
        printBindingSteps(identity.agentId);
        process.stdout.write('\nWaiting for App approval...\n');
      },
      onPending: (pending) => {
        const signature = `${pending.status}:${pending.error}`;
        if (signature === lastProgress) return;
        lastProgress = signature;
        const seconds = Math.round((pending.intervalMs ?? 0) / 1000);
        process.stdout.write(`  waiting (${pending.error}) — next poll in ${seconds}s\n`);
      },
    });

    process.stdout.write('\nAuthorization complete.\n');
    printIdentity(identity.agentId, identity.deviceId);
    if (result && result.expiresAt) {
      process.stdout.write(`Session expires at: ${new Date(result.expiresAt).toISOString()}\n`);
    }
    process.stdout.write('Refresh token: stored by the protocol client (state.json, mode 0600)\n');
    printBindingSteps(identity.agentId);
    printRestartSteps();
  } catch (error) {
    if (interrupted) {
      process.stderr.write('Login cancelled by user.\n');
    } else {
      const code = error && error.code ? ` [${error.code}]` : '';
      process.stderr.write(`Livis login failed${code}: ${redact(error && error.message)}\n`);
    }
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const stateDir = resolve(expandHome(options.stateDir ?? DEFAULT_STATE_DIR));
  const client = createLivisClient({ stateDir, environment: 'production' });

  const run = options.mode === 'status'
    ? runStatus(client, stateDir)
    : options.mode === 'logout'
      ? runLogout(client, stateDir)
      : runLogin(client, stateDir, options.force);

  run.catch((error) => {
    const code = error && error.code ? ` [${error.code}]` : '';
    process.stderr.write(`livis-login failed${code}: ${redact(error && error.message)}\n`);
    process.exitCode = 1;
  });
}

main();
