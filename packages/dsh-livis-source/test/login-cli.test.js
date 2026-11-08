import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/livis-login.mjs', import.meta.url));
const TOKEN_SHAPE = /(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|FAKE_[A-Z0-9_]*TOKEN|(?:access_token|refresh_token|device_code)=[^&\s]+|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/;

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('P4a A1: --help exits 0 and documents the App path + restart command', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Livis device-code login/);
  assert.match(result.stdout, /理想同学 App → 设置 → 连接与服务 → 连接我的 Agent/);
  assert.match(result.stdout, /tmux new-session -d -s dsh-livis/);
  assert.match(result.stdout, /Exit codes:/);
  assert.doesNotMatch(result.stdout + result.stderr, TOKEN_SHAPE);
});

test('P4a A1/A3: --status is local-only, creates 0700/0600 state, and prints no token', () => {
  const root = mkdtempSync(join(tmpdir(), 'livis-login-test-'));
  try {
    const stateDir = join(root, 'client');
    const result = run(['--status', '--state-dir', stateDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Agent ID:\s+hermes-/);
    assert.match(result.stdout, /Device ID:\s+pc_/);
    assert.match(result.stdout, /Refresh token: absent/);
    assert.match(result.stdout, /Access token \(cached\): absent/);
    assert.match(result.stdout, /Network calls: none/);
    assert.doesNotMatch(result.stdout + result.stderr, TOKEN_SHAPE);

    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(stateDir, 'state.json')).mode & 0o777, 0o600);
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    assert.equal(state.refreshToken, null);
    assert.match(state.agentId, /^hermes-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P4a A1: --logout on an unauthenticated state dir is local-only and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'livis-login-test-'));
  try {
    const stateDir = join(root, 'client');
    const ready = run(['--status', '--state-dir', stateDir]);
    assert.equal(ready.status, 0, ready.stderr);
    const result = run(['--logout', '--state-dir', stateDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local refresh token: cleared/);
    assert.doesNotMatch(result.stdout + result.stderr, TOKEN_SHAPE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P4a A1: usage errors exit 2', () => {
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--status', '--force']).status, 2);
  assert.equal(run(['--state-dir']).status, 2);
  assert.equal(run(['--help', '--status']).status, 2);
});
