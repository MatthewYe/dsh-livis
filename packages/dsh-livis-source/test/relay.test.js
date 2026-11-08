/**
 * Gate tests for the P3 Livis Source relay: trigger shape/policy (G3-1),
 * engine acknowledgement consumption (G3-2), fallback and late-result drop
 * (G3-4), and concurrency/restart dedupe (G3-5). G3-3 runs against the real
 * 3083 router in scripts/p3-g3-3.mjs.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFakeHub } from 'dsh-livis-protocol/testing/fake-hub'
import { createLivisSourceKind } from '../index.js'
import { createLivisRelay, normalizeInbound, stripWakeWord, stripVoiceLeadIn } from '../src/relay.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(10)
  }
}

function frameFor({ jobId, msgId, content, fromNodeId }) {
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
      data: { content, files: [] },
      from_node_id: fromNodeId,
      from_node_type: 'personl-device',
      nodeType: 'personl-device',
    },
  }
}

async function harness({ config = {}, receive = async () => 'stored', clientOptions = {} } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-livis-source-p3-'))
  const hub = await createFakeHub()
  const triggers = []
  const reports = []
  const source = {
    ready: Promise.resolve(),
    config: () => config,
    receive: async (trigger) => {
      triggers.push(trigger)
      return receive(trigger)
    },
    report: (entry, health) => reports.push({ entry, health }),
  }
  let relay = null
  const kind = createLivisSourceKind(() => relay)
  const makeRelay = () => createLivisRelay({
    source,
    config: {
      enabled: true,
      stateDir,
      fallbackText: '抱歉，这条消息没有产生可执行的任务。',
      pendingTimeoutMs: 1000,
      allowedActor: '',
      ...config,
    },
    stateDir,
    silent: true,
    clientOptions: {
      websocketUrl: hub.urls.ws,
      httpUrl: hub.urls.http,
      idaasEndpoint: hub.urls.idaas,
      refreshToken: 'FAKE_REFRESH_TOKEN_P3',
      connectTimeoutMs: 3000,
      ackTimeoutMs: 1000,
      heartbeatMs: 25,
      reconnectBaseMs: 20,
      reconnectMaxMs: 60,
      ...clientOptions,
    },
  })
  relay = makeRelay()
  return {
    hub,
    kind,
    reports,
    stateDir,
    triggers,
    get relay() { return relay },
    async start() { await relay.start() },
    async restart() {
      await relay.stop()
      relay = makeRelay()
      await relay.start()
    },
    async dispose() {
      await relay.stop().catch(() => {})
      await hub.close()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

function outbound(kind, trigger, text) {
  return { id: `${kind}:${trigger.id}`, channel: trigger.channel, text, kind }
}

test('G3-1: inbound send_message becomes a direct Livis Trigger with the right thread and address', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.start()
  h.hub.send(frameFor({ jobId: 'job-g31', msgId: 'msg-g31', content: 'hello', fromNodeId: 'user-g31' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'trigger' })

  assert.equal(trigger.source, 'livis')
  assert.equal(trigger.id, 'livis:job-g31')
  assert.deepEqual(trigger.threads, [{ source: 'livis', id: 'user-g31' }])
  assert.equal(trigger.channel.thread, 'livis:user-g31')
  assert.deepEqual(trigger.channel.address, {
    jobId: 'job-g31', msgId: 'msg-g31', fromNodeId: 'user-g31', nodeType: 'personl-device',
  })
  assert.equal(trigger.actor.source, 'livis')
  assert.equal(trigger.actor.id, 'user-g31')
  assert.equal(trigger.human, true)
  assert.equal(trigger.addressed, 'direct')
  assert.equal(trigger.text, 'hello')
})

test('G3-1: an actor outside allowedActor produces no Trigger and no result', async (t) => {
  const h = await harness({ config: { allowedActor: 'user-bound' } })
  t.after(() => h.dispose())
  await h.start()
  h.hub.send(frameFor({ jobId: 'job-g31-b', msgId: 'msg-g31-b', content: 'hello', fromNodeId: 'user-stranger' }))
  await sleep(200)
  assert.equal(h.triggers.length, 0)
  assert.equal(h.hub.results.length, 0)

  h.hub.send(frameFor({ jobId: 'job-g31-a', msgId: 'msg-g31-a', content: 'hello', fromNodeId: 'user-bound' }))
  await waitFor(() => h.triggers[0], { label: 'bound trigger' })
  assert.equal(h.triggers[0].actor.id, 'user-bound')
})

test('G3-2: an engine acknowledgement is consumed locally, accepted, and never sent to the relay', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.start()
  h.hub.send(frameFor({ jobId: 'job-g32', msgId: 'msg-g32', content: 'hello', fromNodeId: 'user-g32' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'trigger' })

  const outcome = await h.kind.channel.send({ commands: {} }, outbound('acknowledgement', trigger, '正在处理'))
  assert.equal(outcome, 'sent')
  assert.equal(h.relay.job('job-g32').status, 'accepted')
  assert.equal(h.hub.framesOf('ack_send_message').length, 1, 'only the protocol auto-ack may reach the relay')
  assert.equal(h.hub.results.length, 0)
  await sleep(100)
  assert.equal(h.hub.results.length, 0)

  // A late duplicate acknowledgement is dropped, and a notice never reaches the relay.
  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('acknowledgement', trigger, 'again')), 'sent')
  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('notice', trigger, 'notice text')), 'gone')
  assert.equal(h.hub.results.length, 0)
})

test('P4: a final reply persists finalText and one delivery for real-device evidence', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.start()
  h.hub.send(frameFor({ jobId: 'job-p4-final', msgId: 'msg-p4-final', content: '只回答 pong', fromNodeId: 'user-p4' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'trigger' })

  const outcome = await h.kind.channel.send({ commands: {} }, outbound('reply', trigger, 'pong'))
  assert.equal(outcome, 'sent')
  const job = h.relay.job('job-p4-final')
  assert.equal(job.status, 'final')
  assert.equal(job.resultKind, 'reply')
  assert.equal(job.finalText, 'pong')
  assert.equal(job.resultDeliveries, 1)
  assert.equal(h.hub.results.length, 1)
})

test('G3-4: a filtered job sends one fallback final after the pending timeout and drops a late reply', async (t) => {
  const h = await harness({ config: { pendingTimeoutMs: 200 }, receive: async () => 'filtered' })
  t.after(() => h.dispose())
  await h.start()
  h.hub.send(frameFor({ jobId: 'job-g34', msgId: 'msg-g34', content: '好的', fromNodeId: 'user-g34' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'trigger' })

  await waitFor(() => h.hub.results.length === 1, { label: 'fallback result', timeoutMs: 3000 })
  const text = JSON.parse(h.hub.results[0].frame.payload.data).text
  assert.equal(text, '抱歉，这条消息没有产生可执行的任务。')
  assert.equal(h.relay.job('job-g34').status, 'final')
  assert.equal(h.relay.job('job-g34').resultKind, 'fallback')

  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('reply', trigger, 'too late')), 'gone')
  await sleep(150)
  assert.equal(h.hub.results.length, 1)
})

test('G3-5: two concurrent jobs keep their own channel, and a restart never duplicates a final', async (t) => {
  const h = await harness({ config: { pendingTimeoutMs: 5000 } })
  t.after(() => h.dispose())
  await h.start()
  h.hub.send(frameFor({ jobId: 'job-g35-a', msgId: 'msg-a', content: 'first', fromNodeId: 'user-g35' }))
  h.hub.send(frameFor({ jobId: 'job-g35-b', msgId: 'msg-b', content: 'second', fromNodeId: 'user-g35' }))
  await waitFor(() => h.triggers.length === 2, { label: 'two triggers' })
  const [a, b] = h.triggers

  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('acknowledgement', a, 'ok')), 'sent')
  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('acknowledgement', b, 'ok')), 'sent')
  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('reply', a, 'pong-a')), 'sent')
  assert.equal(await h.kind.channel.send({ commands: {} }, outbound('reply', b, 'pong-b')), 'sent')

  await waitFor(() => h.hub.results.length === 2, { label: 'two results' })
  const byJob = new Map(h.hub.results.map((entry) => [entry.frame.metadata.job_id, JSON.parse(entry.frame.payload.data).text]))
  assert.equal(byJob.get('job-g35-a'), 'pong-a')
  assert.equal(byJob.get('job-g35-b'), 'pong-b')

  await h.restart()
  h.hub.send(frameFor({ jobId: 'job-g35-a', msgId: 'msg-a', content: 'first', fromNodeId: 'user-g35' }))
  await sleep(500)
  assert.equal(h.triggers.length, 2, 'a completed job must not produce a second Trigger after restart')
  assert.equal(h.hub.results.length, 2, 'a completed job must not produce a second final after restart')
  assert.equal(h.relay.job('job-g35-a').status, 'final')
})

test('P4 W1/W2: all official wake-word variants are stripped before the Trigger', () => {
  const strippedCases = [
    ['让我的个人agent只回答poon不要修改文件', '只回答poon不要修改文件'],
    ['让我的个人 Agent，只回答poon不要修改文件', '只回答poon不要修改文件'],
    ['让我的个人 agent 只回答 pong（不要修改文件）', '只回答 pong（不要修改文件）'],
    ['让我的个人终端：明天天气怎么样？', '明天天气怎么样？'],
    ['让我的open claw，你好', '你好'],
    ['让我的openclaw 你好', '你好'],
    ['让我的OpenClaw只回答pong', '只回答pong'],
    ['让我的小龙虾！只回答pong', '只回答pong'],
    ['让我的个人\u200bAgent\u200b只回答pong', '只回答pong'],
  ]
  for (const [input, expected] of strippedCases) {
    const result = stripWakeWord(input)
    assert.equal(result.rawText, input, 'rawText must be preserved')
    assert.equal(result.text, expected, `stripped text for ${JSON.stringify(input)}`)
    assert.equal(result.stripped, true)
    assert.equal(result.wakeWordOnly, false)
  }

  const plain = '只回答poon不要修改文件'
  assert.deepEqual(stripWakeWord(plain), {
    text: plain,
    rawText: plain,
    stripped: false,
    wakeWordOnly: false,
  })
  assert.equal(stripWakeWord('让我的个人助手你好').text, '让我的个人助手你好')
})

test('P4 W1/W2: fake-hub inbound Trigger uses stripped text and keeps rawText', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.start()

  const raw = '让我的个人agent只回答poon不要修改文件'
  h.hub.send(frameFor({ jobId: 'job-wake', msgId: 'msg-wake', content: raw, fromNodeId: 'user-wake' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'wake trigger' })

  assert.equal(trigger.text, '只回答poon不要修改文件')
  assert.equal(trigger.meta.rawText, raw)
  assert.equal(trigger.meta.wakeWordStripped, true)
  assert.equal(trigger.meta.wakeWordOnly, false)
  const job = h.relay.job('job-wake')
  assert.equal(job.text, '只回答poon不要修改文件')
  assert.equal(job.rawText, raw)
  assert.equal(job.wakeStripped, true)
  assert.equal(job.wakeWordOnly, false)
})

test('P4 W3: spoken lead-ins ("我问他" / "我问你") are stripped, rawText preserved', () => {
  const cases = [
    ['我问他1+1等于几', '1+1等于几'],
    ['我问你，只回答 pong，不要修改文件', '只回答 pong，不要修改文件'],
    ['我跟他说：明天天气怎么样？', '明天天气怎么样？'],
    ['我对他 1+1等于几', '1+1等于几'],
  ]
  for (const [input, expected] of cases) {
    const result = stripVoiceLeadIn(input)
    assert.equal(result.rawText, input, 'rawText must be preserved')
    assert.equal(result.text, expected, `stripped text for ${JSON.stringify(input)}`)
    assert.equal(result.stripped, true)
  }

  const plain = '今天天气不错'
  assert.deepEqual(stripVoiceLeadIn(plain), { text: plain, rawText: plain, stripped: false })
  assert.equal(stripVoiceLeadIn('我问他').text, '我问他')

  const combined = normalizeInbound('让我的个人Agent我问他1+1等于几')
  assert.equal(combined.text, '1+1等于几')
  assert.equal(combined.rawText, '让我的个人Agent我问他1+1等于几')
  assert.equal(combined.stripped, true)
  assert.equal(combined.leadInStripped, true)
  assert.equal(normalizeInbound('今天天气不错').leadInStripped, false)
})

test('P4 W3: fake-hub inbound Trigger strips the spoken lead-in as well', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.start()

  const raw = '我问他1+1等于几'
  h.hub.send(frameFor({ jobId: 'job-lead-in', msgId: 'msg-lead-in', content: raw, fromNodeId: 'user-lead-in' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'lead-in trigger' })

  assert.equal(trigger.text, '1+1等于几')
  assert.equal(trigger.meta.rawText, raw)
  assert.equal(trigger.meta.leadInStripped, true)
  const job = h.relay.job('job-lead-in')
  assert.equal(job.text, '1+1等于几')
  assert.equal(job.rawText, raw)
  assert.equal(job.leadInStripped, true)
})

test('P4 W2: a wake-word-only message keeps the original text instead of an empty question', async (t) => {
  const h = await harness()
  t.after(() => h.dispose())
  await h.start()

  const raw = '让我的个人Agent，'
  h.hub.send(frameFor({ jobId: 'job-wake-only', msgId: 'msg-wake-only', content: raw, fromNodeId: 'user-wake-only' }))
  const trigger = await waitFor(() => h.triggers[0], { label: 'wake-only trigger' })

  assert.equal(trigger.text, raw)
  assert.equal(trigger.meta.rawText, raw)
  assert.equal(trigger.meta.wakeWordOnly, true)
  const job = h.relay.job('job-wake-only')
  assert.equal(job.text, raw)
  assert.equal(job.rawText, raw)
  assert.equal(job.wakeWordOnly, true)
})
