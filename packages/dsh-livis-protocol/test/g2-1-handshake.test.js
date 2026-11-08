import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from './helpers.js';

test('G2-1: connect frame matches the Hermes v0.1.9 handshake shape', async (t) => {
  const harness = await createHarness({
    config: { heartbeatMs: 20, environment: 'test' },
  });
  t.after(() => harness.dispose());
  const { hub, client } = harness;

  await client.start();

  const connection = await hub.waitForConnection(1);
  assert.equal(connection.protocolVersion, '1', 'protocol_version query parameter must be 1');
  assert.match(connection.url, /protocol_version=1/);

  const [connect] = hub.framesOf('connect');
  assert.ok(connect, 'a connect frame must be sent');

  // --- metadata: common envelope minus device_id, as in official Hermes ---
  assert.equal(connect.metadata.client, 'hermes');
  assert.match(connect.metadata.agent_id, /^hermes-[0-9a-f-]{36}$/);
  assert.equal(
    Object.prototype.hasOwnProperty.call(connect.metadata, 'device_id'),
    false,
    'connect metadata must not carry device_id',
  );
  assert.ok(connect.metadata.msg_id);
  assert.ok(connect.metadata.job_id);
  assert.ok(Number.isFinite(connect.metadata.timestamp));

  // --- payload: identity + credentials + node description, no nodeType ---
  assert.equal(connect.payload.client, 'hermes');
  assert.match(connect.payload.device_id, /^pc_[0-9a-f-]{36}$/);
  assert.equal(connect.payload.node_name, 'Hermes Agent');
  assert.equal(connect.payload.node_desc, 'personl-device Hermes Agent');
  assert.equal(connect.payload.nodeType, undefined);
  assert.equal(connect.payload.token, hub.lastIssuedAccessToken());
  assert.equal(connect.payload.refresh_token, hub.lastIssuedRefreshToken());
  assert.ok(connect.payload.token);
  assert.ok(connect.payload.refresh_token);

  // Tokens live only in payload, never in metadata.
  assert.doesNotMatch(JSON.stringify(connect.metadata), /FAKE_/);

  // --- three consecutive heartbeats on the configured interval ---
  const beats = await hub.waitForFrames('heartbeat', 3, { timeoutMs: 4_000 });
  for (const beat of beats) {
    assert.equal(beat.payload.nodeType, 'personl-device');
    assert.equal(beat.metadata.client, 'hermes');
    assert.ok(beat.metadata.msg_id);
    assert.ok(beat.metadata.job_id);
    assert.equal(beat.metadata.agent_id, connect.metadata.agent_id);
    assert.match(beat.metadata.device_id, /^pc_/);
    assert.doesNotMatch(JSON.stringify(beat.payload), /FAKE_/);
  }
  const heartbeatTimes = hub.heartbeats.slice(0, 3).map((entry) => entry.at);
  for (let index = 1; index < heartbeatTimes.length; index += 1) {
    const gap = heartbeatTimes[index] - heartbeatTimes[index - 1];
    assert.ok(gap >= 8, `heartbeat gap should be near 20ms, got ${gap}ms`);
    assert.ok(gap < 500, `heartbeat gap should not drift, got ${gap}ms`);
  }

  // --- health reflects the accepted handshake, with no credentials ---
  const health = client.health();
  assert.equal(health.phase, 'connected');
  assert.equal(health.connected, true);
  assert.equal(health.handshakeAccepted, true);
  assert.equal(health.client, 'hermes');
  assert.equal(health.nodeType, 'personl-device');
  assert.equal(health.hasRefreshToken, true);
  assert.equal(health.hasAccessToken, true);
  assert.equal(health.agentId, connect.metadata.agent_id);
  assert.equal(health.deviceId, connect.payload.device_id);
  assert.ok(health.transitions.some((entry) => entry.phase === 'handshaking'));
  assert.ok(health.transitions.some((entry) => entry.phase === 'connected'));
  assert.doesNotMatch(JSON.stringify(health), /FAKE_/);
  assert.doesNotMatch(JSON.stringify(health), /bearer/i);

  await client.stop();
  assert.equal(client.health().phase, 'stopped');
});
