import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, messageFrame, sleep, waitFor } from './helpers.js';

test('G2-3: send_result nests compact JSON, waits for ack, retries at-least-once, and never duplicates a job', async (t) => {
  const harness = await createHarness({
    config: { ackTimeoutMs: 120, maxResultAttempts: 4 },
  });
  t.after(() => harness.dispose());
  const { hub, client } = harness;

  await client.start();
  const messages = [];
  client.on('message', (task) => messages.push(task));

  // ---------- happy path: nested JSON string + ack ----------
  const jobOne = 'job-result-happy';
  hub.send(messageFrame({ jobId: jobOne }));
  await waitFor(() => messages.length === 1, { label: 'first job delivered' });

  const files = [{ name: 'answer.pdf', objectKey: 'files/answer.pdf', fileSuffix: 'pdf' }];
  const outcome = await client.sendResult(jobOne, { text: 'done', files });
  assert.deepEqual(outcome, {
    sent: true,
    duplicate: false,
    replay: false,
    attempts: 1,
    jobId: jobOne,
  });

  const [resultFrame] = await hub.waitForResultFrames(1);
  assert.equal(resultFrame.type, 'send_result');
  assert.equal(resultFrame.metadata.job_id, jobOne);
  assert.equal(resultFrame.metadata.client, 'hermes');
  assert.equal(resultFrame.metadata.device_id.startsWith('pc_'), true);
  assert.equal(resultFrame.payload.nodeType, 'personl-device');
  assert.equal(typeof resultFrame.payload.data, 'string', 'payload.data must be a JSON string');
  // Exact compact form: no spaces after ':' or ',', matching official Hermes.
  assert.equal(resultFrame.payload.data, JSON.stringify({ text: 'done', files }));
  assert.deepEqual(JSON.parse(resultFrame.payload.data), { text: 'done', files });

  let health = client.health();
  assert.equal(health.counters.resultsSent, 1);
  assert.equal(health.counters.resultsAcked, 1);
  assert.equal(health.jobs.completed, 1);
  assert.equal(health.pendingResultAcks, 0);

  // A second send_result for a completed job is dropped, not sent again.
  const duplicate = await client.sendResult(jobOne, { text: 'second answer' });
  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.attempts, 0);
  assert.equal(hub.results.filter((entry) => entry.frame.metadata.job_id === jobOne).length, 1);
  assert.equal(client.health().counters.droppedResults, 1);

  // ---------- ack lost: 4 attempts (initial + 3 retries), then a typed failure ----------
  hub.ackResults = false;
  const jobTwo = 'job-result-unacked';
  hub.send(messageFrame({ jobId: jobTwo }));
  await waitFor(() => messages.length === 2, { label: 'second job delivered' });

  await assert.rejects(client.sendResult(jobTwo, { text: 'retry me' }), (error) => {
    assert.equal(error.code, 'LIVIS_RESULT_NOT_ACKED');
    assert.equal(error.jobId, jobTwo);
    assert.equal(error.attempts, 4);
    return true;
  });

  const attempts = hub.results
    .filter((entry) => entry.frame.metadata.job_id === jobTwo)
    .map((entry) => entry.frame);
  assert.equal(attempts.length, 4, 'one initial send plus three retries');
  assert.equal(new Set(attempts.map((frame) => frame.metadata.msg_id)).size, 4);
  assert.equal(new Set(attempts.map((frame) => frame.payload.data)).size, 1);
  assert.equal(attempts[0].payload.data, JSON.stringify({ text: 'retry me' }));
  assert.equal(attempts.every((frame) => frame.metadata.job_id === jobTwo), true);

  health = client.health();
  assert.equal(health.counters.resultsSent, 5);
  assert.equal(health.counters.resultsAcked, 1);
  assert.equal(health.jobs.resultPending, 1);
  assert.equal(health.pendingResultAcks, 0);
  assert.equal(health.lastError.code, 'LIVIS_RESULT_NOT_ACKED');

  // The result was persisted before sending, so it can be retried later.
  const tokenState = await client.tokenState();
  assert.equal(tokenState.hasRefreshToken, true);

  // ---------- recovery: ack resumes, cached result is delivered again ----------
  hub.ackResults = true;
  const retried = await client.retryResult(jobTwo);
  assert.equal(retried.sent, true);
  assert.equal(retried.attempts, 1);
  assert.equal(hub.results.filter((entry) => entry.frame.metadata.job_id === jobTwo).length, 5);

  // ---------- duplicate delivery after completion: ack + replay, no new trigger ----------
  const beforeDuplicates = messages.length;
  hub.send(messageFrame({ jobId: jobTwo, msgId: 'duplicate-msg-1', content: 'third try' }));
  await hub.waitForFrame('ack_send_message', {
    where: (frame) => frame.metadata?.job_id === jobTwo,
    index: 1,
  });
  await waitFor(
    () => hub.results.filter((entry) => entry.frame.metadata.job_id === jobTwo).length === 6,
    { label: 'cached result replay' },
  );
  await sleep(60);

  assert.equal(messages.length, beforeDuplicates, 'duplicate delivery must not emit a new message');
  health = client.health();
  assert.equal(health.counters.duplicateMessages >= 1, true);
  assert.equal(health.counters.replayedResults, 1);
  assert.equal(health.jobs.completed, 2);

  const replayFrames = hub.results.filter((entry) => entry.frame.metadata.job_id === jobTwo);
  assert.equal(replayFrames.at(-1).frame.payload.data, attempts[0].payload.data);
  assert.notEqual(replayFrames.at(-1).frame.metadata.msg_id, attempts.at(-1).metadata.msg_id);
});
