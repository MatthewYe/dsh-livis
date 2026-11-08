import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, messageFrame, sleep, waitFor } from './helpers.js';
import { createMemoryLogger } from '../src/redact.js';

test('G2-6: token_expiring refreshes once without a reconnect storm; logs and health never leak tokens', async (t) => {
  const logs = createMemoryLogger();
  const harness = await createHarness({ config: { logger: logs } });
  t.after(() => harness.dispose());
  const { hub, client } = harness;

  // --- lifecycle before start ---
  assert.equal(client.health().phase, 'stopped');

  const connectedEvents = [];
  client.on('connected', (event) => connectedEvents.push(event));
  await client.start();
  assert.equal(client.health().phase, 'connected');
  assert.equal(connectedEvents.length, 1);

  const messages = [];
  client.on('message', (task) => messages.push(task));
  const jobId = 'job-token-refresh';
  hub.send(messageFrame({ jobId }));
  await waitFor(() => messages.length === 1, { label: 'job delivered' });
  const delivered = await client.sendResult(jobId, { text: 'nothing sensitive here' });
  assert.equal(delivered.sent, true);

  // --- two token_expiring frames in quick succession: one refresh, no reconnect ---
  const refreshed = client.waitForEvent('token-refreshed');
  hub.send({ type: 'token_expiring' });
  hub.send({ type: 'token_expiring' });
  await refreshed;
  await hub.waitForFrame('token_refresh');
  await sleep(120);

  assert.equal(hub.framesOf('token_refresh').length, 1, 'in-flight refresh must be single-flight');
  assert.equal(hub.connections.length, 1, 'token refresh must not reconnect');
  assert.equal(client.health().counters.tokenRefreshes, 1);
  assert.equal(client.health().connected, true);

  const tokenRefreshFrame = hub.framesOf('token_refresh')[0];
  assert.equal(tokenRefreshFrame.payload.nodeType, 'personl-device');
  assert.equal(tokenRefreshFrame.payload.token, hub.lastIssuedAccessToken());
  assert.equal(tokenRefreshFrame.payload.refresh_token, hub.lastIssuedRefreshToken());

  // --- redaction: no credential value in any log line or health snapshot ---
  const logText = logs.text();
  assert.ok(logText.length > 0, 'the client should have logged lifecycle events');
  for (const secret of [
    'FAKE_ACCESS_TOKEN',
    'FAKE_REFRESH_TOKEN',
    'FAKE_REFRESH_TOKEN_BOOTSTRAP',
    'Bearer ',
  ]) {
    assert.equal(logText.includes(secret), false, `logs must not contain ${secret}`);
  }
  assert.equal(logText.includes(tokenRefreshFrame.payload.token), false);
  assert.equal(logText.includes(tokenRefreshFrame.payload.refresh_token), false);

  const healthText = JSON.stringify(client.health());
  for (const secret of ['FAKE_ACCESS_TOKEN', 'FAKE_REFRESH_TOKEN', 'Bearer ']) {
    assert.equal(healthText.includes(secret), false, `health must not contain ${secret}`);
  }
  assert.equal(healthText.includes(tokenRefreshFrame.payload.token), false);
  assert.equal(healthText.includes(tokenRefreshFrame.payload.refresh_token), false);

  // --- reconnect: drops are reflected in health, then recovery happens ---
  const disconnected = client.waitForEvent('disconnected');
  const reconnected = client.waitForEvent('connected');
  const identityBefore = client.getIdentity();
  await hub.dropConnections(1011, 'test-drop');
  await disconnected;
  assert.equal(client.health().phase, 'reconnecting');
  assert.equal(client.health().connected, false);

  await reconnected;
  await hub.waitForConnection(2);
  assert.equal(client.health().phase, 'connected');
  assert.equal(hub.connections.length, 2);
  assert.deepEqual(client.getIdentity(), identityBefore, 'identity must survive reconnects');

  const secondConnect = hub.framesOf('connect')[1];
  assert.equal(secondConnect.payload.device_id, identityBefore.deviceId);
  assert.equal(secondConnect.metadata.agent_id, identityBefore.agentId);

  const transitions = client.health().transitions.map((entry) => entry.phase);
  assert.ok(transitions.includes('reconnecting'));
  assert.equal(transitions.at(-1), 'connected');

  // --- stop is terminal: no heartbeats or frames afterwards ---
  await client.stop();
  assert.equal(client.health().phase, 'stopped');
  const framesAtStop = hub.frames.length;
  await sleep(120);
  assert.equal(hub.frames.length, framesAtStop, 'stopped client must not keep sending');
});
