import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, messageFrame, waitFor } from './helpers.js';

test('G2-2: inbound send_message parses JSON-string and object data; malformed frames do not crash', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  const { hub, client } = harness;

  await client.start();
  const messages = [];
  client.on('message', (task) => messages.push(task));

  // --- payload.data as a JSON string (the production gateway shape) ---
  const jobString = 'job-inbox-string';
  hub.send(
    messageFrame({
      jobId: jobString,
      content: 'ignored because explicit data wins',
      data: JSON.stringify({
        content: '  hello from a JSON string  ',
        files: [{ name: 'brief.pdf', objectKey: 'files/brief.pdf' }],
        extra: 42,
      }),
    }),
  );

  await waitFor(() => messages.length === 1, { label: 'first parsed message' });
  const first = messages[0];
  assert.equal(first.jobId, jobString);
  assert.equal(first.msgId.length > 0, true);
  assert.equal(first.content, 'hello from a JSON string');
  assert.equal(first.fromNodeId, 'livis-user-node-1');
  assert.equal(first.fromNodeType, 'livis-user');
  assert.equal(first.data.extra, 42);
  assert.equal(first.data.files.length, 1);
  assert.equal(first.data.files[0].name, 'brief.pdf');

  // The client must ack the job id even though the payload has no job id.
  const ackString = await hub.waitForFrame('ack_send_message', {
    where: (frame) => frame.metadata?.job_id === jobString,
  });
  assert.equal(ackString.payload.nodeType, 'personl-device');
  assert.equal(ackString.metadata.client, 'hermes');

  // --- payload.data as an object ---
  const jobObject = 'job-inbox-object';
  hub.send(
    messageFrame({
      jobId: jobObject,
      data: { content: 'object data body', files: [] },
      fromNodeId: 'livis-user-node-2',
    }),
  );
  await waitFor(() => messages.length === 2, { label: 'second parsed message' });
  const second = messages[1];
  assert.equal(second.jobId, jobObject);
  assert.equal(second.content, 'object data body');
  assert.equal(second.fromNodeId, 'livis-user-node-2');
  assert.equal(second.fromNodeType, 'livis-user');
  await hub.waitForFrame('ack_send_message', {
    where: (frame) => frame.metadata?.job_id === jobObject,
  });

  // --- malformed frames are logged and skipped, never fatal ---
  hub.sendRaw('{ this is not json');
  hub.send({
    type: 'send_message',
    metadata: { msg_id: 'bad-1', job_id: 'job-bad-json' },
    payload: { data: 'not-json-either', from_node_id: 'user-1' },
  });
  hub.send({
    type: 'send_message',
    metadata: { msg_id: 'bad-2', job_id: 'job-bad-no-from-node' },
    payload: { data: { content: 'missing from_node_id' } },
  });
  hub.send({ type: 'send_message', metadata: { msg_id: 'bad-3' }, payload: {} });

  await waitFor(() => client.health().counters.invalidFrames >= 4, {
    label: 'four invalid frames counted',
  });
  assert.equal(client.health().connected, true);
  assert.equal(hub.connections.length, 1, 'malformed frames must not force a reconnect');
  assert.equal(client.health().counters.inbound >= 2, true);
  assert.equal(
    hub.framesOf('ack_send_message').some((frame) => frame.metadata?.job_id === 'job-bad-json'),
    false,
    'malformed tasks must not be acked',
  );

  // A valid frame after the malformed ones still works.
  const jobRecovery = 'job-inbox-recovery';
  hub.send(messageFrame({ jobId: jobRecovery, content: 'still alive' }));
  await waitFor(() => messages.length === 3, { label: 'message after malformed frames' });
  assert.equal(messages[2].content, 'still alive');
  assert.equal(client.health().connected, true);

  // --- cancel_chat is acknowledged and surfaced once ---
  const cancels = [];
  client.on('cancel', (event) => cancels.push(event));
  hub.send({
    type: 'cancel_chat',
    metadata: { msg_id: 'cancel-msg-1', job_id: jobRecovery },
    payload: {},
  });
  await waitFor(() => cancels.length === 1, { label: 'cancel event' });
  assert.equal(cancels[0].jobId, jobRecovery);
  await hub.waitForFrame('ack_cancel_chat', {
    where: (frame) => frame.metadata?.job_id === jobRecovery,
  });
  assert.equal(client.health().jobs.canceled, 1);

  // A duplicate delivery of the canceled job is acked but not re-emitted.
  hub.send(messageFrame({ jobId: jobRecovery, content: 'canceled duplicate' }));
  await waitFor(() => client.health().counters.duplicateMessages >= 1, {
    label: 'canceled duplicate counted',
  });
  await hub.waitForFrame('ack_send_message', {
    where: (frame) => frame.metadata?.job_id === jobRecovery,
    index: 1,
  });
  assert.equal(messages.length, 3, 'canceled jobs must not be executed again');
});
