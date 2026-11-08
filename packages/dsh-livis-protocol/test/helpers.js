/**
 * Shared harness for the gate tests.
 *
 * Every harness gets its own temp state dir and its own local fake hub; the
 * client never sees a real gateway URL or a real credential.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createFakeHub } from '../src/testing/fake-hub.js';
import { createLivisClient } from '../src/client.js';
import { createSilentLogger } from '../src/redact.js';

export async function waitFor(predicate, { timeoutMs = 5_000, label = 'condition', intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = predicate();
    } catch (error) {
      throw error;
    }
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inbound send_message fixture. Defaults mirror what the Livis gateway sends.
 * Pass `data` as a string to exercise the JSON-string path, or as an object to
 * exercise the object path.
 */
export function messageFrame({
  jobId = `job-${randomUUID()}`,
  msgId = randomUUID(),
  content = 'hello from livis',
  data,
  fromNodeId = 'livis-user-node-1',
  fromNodeType = 'livis-user',
} = {}) {
  const inner = data ?? { content, files: [] };
  return {
    type: 'send_message',
    metadata: {
      msg_id: msgId,
      job_id: jobId,
      agent_id: 'hermes-test-agent',
      device_id: 'pc_test_device',
      client: 'hermes',
      timestamp: Date.now(),
    },
    payload: {
      data: inner,
      from_node_id: fromNodeId,
      from_node_type: fromNodeType,
      nodeType: 'personl-device',
    },
  };
}

export async function createHarness(options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'livis-protocol-test-'));
  const hub = await createFakeHub(options.hub ?? {});
  const config = {
    stateDir,
    websocketUrl: hub.urls.ws,
    httpUrl: hub.urls.http,
    idaasEndpoint: hub.urls.idaas,
    refreshToken: 'FAKE_REFRESH_TOKEN_BOOTSTRAP',
    logger: createSilentLogger(),
    connectTimeoutMs: 3_000,
    ackTimeoutMs: 400,
    heartbeatMs: 25,
    reconnectBaseMs: 20,
    reconnectMaxMs: 60,
    ...(options.config ?? {}),
  };
  const client = createLivisClient(config);
  let disposed = false;
  return {
    hub,
    client,
    config,
    stateDir,
    get disposed() {
      return disposed;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await client.stop();
      } catch {
        // already stopped
      }
      await hub.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
