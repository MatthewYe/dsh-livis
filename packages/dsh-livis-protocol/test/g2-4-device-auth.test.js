import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeHub } from '../src/testing/fake-hub.js';
import { createStateStore } from '../src/state.js';
import { createDeviceAuth } from '../src/auth.js';
import { createRedactor, createSilentLogger } from '../src/redact.js';

const CLIENT_ID = '6qxd1MLZhAtdWipnmXe1dd';
const AUDIENCE = 'rZgT0SETDNueMVAhfRN10';

async function makeAuth(overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'livis-auth-test-'));
  const hub = await createFakeHub(overrides.hub ?? {});
  const store = createStateStore({ stateDir });
  await store.init();
  const sleeps = [];
  const auth = createDeviceAuth({
    idaasEndpoint: hub.urls.idaas,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    scope: 'super',
    stateStore: store,
    fetchImpl: globalThis.fetch,
    redactor: createRedactor(),
    logger: createSilentLogger(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(overrides.auth ?? {}),
  });
  return {
    hub,
    store,
    auth,
    sleeps,
    stateDir,
    async dispose() {
      await hub.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test('G2-4a: IDaaS device flow handles 428/slow_down, rotates refresh, revokes, and stores state 0600', async (t) => {
  const ctx = await makeAuth();
  t.after(() => ctx.dispose());
  const { hub, store, auth, sleeps } = ctx;

  // --- device code request ---
  const code = await auth.requestDeviceCode();
  assert.equal(code.deviceCode, 'FAKE_DEVICE_CODE_1');
  assert.equal(code.userCode, 'FAKE-USER-CODE');
  assert.equal(code.verificationUri, 'https://verify.livis.test/device');
  assert.equal(code.expiresIn, 600);
  assert.equal(code.interval, 1);

  assert.equal(hub.idaas.auxRequests.length, 1);
  const aux = hub.idaas.auxRequests[0].form;
  assert.equal(aux.client_id, CLIENT_ID);
  assert.equal(aux.scope, 'super offline_access');
  assert.equal(aux.audience, AUDIENCE);
  assert.equal(aux.offline_access, 'true');
  assert.equal(aux.prompt, undefined);

  // --- polling: HTTP 428 pending, then 400 slow_down (+5s), then success ---
  const token = await auth.pollForToken({
    deviceCode: code.deviceCode,
    expiresIn: code.expiresIn,
    interval: code.interval,
  });
  assert.equal(hub.idaas.tokenRequests.length, 3);
  assert.equal(
    hub.idaas.tokenRequests.every(
      (request) => request.form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code',
    ),
    true,
  );
  assert.equal(hub.idaas.tokenRequests[0].form.device_code, 'FAKE_DEVICE_CODE_1');
  assert.equal(hub.idaas.tokenRequests[0].form.client_id, CLIENT_ID);
  assert.deepEqual(sleeps, [1_000, 1_000, 6_000], 'slow_down must add exactly 5s');

  assert.equal(token.accessToken, hub.lastIssuedAccessToken());
  assert.equal(token.refreshToken, hub.lastIssuedRefreshToken());
  assert.equal(token.tokenType, 'Bearer');

  // --- refresh token rotation ---
  const firstRefresh = await store.getRefreshToken();
  assert.equal(firstRefresh, token.refreshToken);
  const refreshedAccess = await auth.forceRefresh();
  const rotatedRefresh = await store.getRefreshToken();
  assert.equal(refreshedAccess, hub.lastIssuedAccessToken());
  assert.notEqual(refreshedAccess, token.accessToken);
  assert.equal(rotatedRefresh, hub.lastIssuedRefreshToken());
  assert.notEqual(rotatedRefresh, firstRefresh);

  const refreshRequests = hub.idaas.tokenRequests.filter(
    (request) => request.form.grant_type === 'refresh_token',
  );
  assert.equal(refreshRequests.length, 1);
  assert.equal(refreshRequests[0].form.refresh_token, firstRefresh);
  assert.equal(refreshRequests[0].form.client_id, CLIENT_ID);

  // --- state file: 0600 file, 0700 dir, no access token ---
  const statePath = join(ctx.stateDir, 'state.json');
  const fileStat = await stat(statePath);
  const dirStat = await stat(ctx.stateDir);
  assert.equal(fileStat.mode & 0o777, 0o600, 'state.json must be 0600');
  assert.equal(dirStat.mode & 0o777, 0o700, 'state dir must be 0700');

  const rawState = await readFile(statePath, 'utf8');
  const parsed = JSON.parse(rawState);
  assert.equal(parsed.refreshToken, rotatedRefresh);
  assert.equal(JSON.stringify(parsed).includes('FAKE_ACCESS_TOKEN'), false);
  assert.equal(JSON.stringify(parsed).includes(token.accessToken), false);

  // --- revoke: refresh token sent, local state cleared ---
  const revoked = await auth.revoke();
  assert.equal(hub.idaas.revokeRequests.length, 1);
  const revokeForm = hub.idaas.revokeRequests[0].form;
  assert.equal(revokeForm.token, rotatedRefresh);
  assert.equal(revokeForm.token_type_hint, 'refresh_token');
  assert.equal(revokeForm.client_id, CLIENT_ID);
  assert.equal(revoked.revoked, true);
  assert.equal(await store.getRefreshToken(), null);
  assert.equal((await auth.tokenState()).hasRefreshToken, false);
});

test('G2-4b: a rejected refresh token clears local state and requires re-login', async (t) => {
  const ctx = await makeAuth({
    hub: { idaas: { refreshScript: [{ status: 401, body: { error: 'invalid_grant' } }] } },
  });
  t.after(() => ctx.dispose());
  const { hub, store, auth } = ctx;

  await store.setRefreshToken('FAKE_REFRESH_TOKEN_SEEDED');
  assert.equal(await store.getRefreshToken(), 'FAKE_REFRESH_TOKEN_SEEDED');

  await assert.rejects(auth.forceRefresh(), (error) => {
    assert.equal(error.code, 'LIVIS_AUTH_FAILED');
    assert.match(error.message, /new device login/i);
    return true;
  });

  assert.equal(await store.getRefreshToken(), null, 'rejected refresh token must be cleared');
  assert.equal(hub.idaas.tokenRequests.length, 1);
  assert.equal(hub.idaas.tokenRequests[0].form.grant_type, 'refresh_token');
  assert.equal(hub.idaas.tokenRequests[0].form.refresh_token, 'FAKE_REFRESH_TOKEN_SEEDED');

  await assert.rejects(auth.forceRefresh(), (error) => {
    assert.equal(error.code, 'LIVIS_AUTH_REQUIRED');
    return true;
  });
});
