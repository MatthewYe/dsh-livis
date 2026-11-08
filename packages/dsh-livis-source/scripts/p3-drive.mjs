/**
 * P3 gate driver. Runs the two livis restarts against a local fake relay,
 * executes the unit gate tests, performs the real-router G3-3 probe, and
 * writes V3-1..V3-6 evidence. Read-only with respect to the superagent repo
 * and the main superagent profile; only the isolated `livis` profile process
 * and the plugin project are touched.
 *
 * Usage: node scripts/p3-drive.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The evidence directory and the restarts live in the sibling dsh-superagent
// checkout; the plugin and protocol packages are resolved from this script, so
// the driver works from any checkout layout. SUPERAGENT_ROOT overrides the repo.
const REPO = process.env.SUPERAGENT_ROOT
  || resolve(fileURLToPath(new URL('../../../../dsh-superagent-prototype', import.meta.url)))
const PLUGIN = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROTOCOL = resolve(fileURLToPath(new URL('../../dsh-livis-protocol', import.meta.url)))
const LIVIS_PROFILE = join(homedir(), '.dsh', 'profiles', 'livis')
const MAIN_PROFILE = join(homedir(), '.dsh', 'profiles', 'superagent')
const LIVIS_STATE = join(homedir(), '.dsh', 'state', 'livis')
const LIVIS_JOURNAL = join(LIVIS_STATE, 'livis-source', 'jobs.json')
const EVID = join(REPO, '.artifacts', 'verify', 'p3')
const HUB_OUT = join(EVID, 'hub')
const HUB_CONTROL = 3091
const LIVIS_PORT = 3083
const MAIN_PORT = 3082
const FAKE_ACTOR = 'livis-p3-user'
const FAKE_REFRESH = 'FAKE_REFRESH_TOKEN_P3'

await mkdir(EVID, { recursive: true })
await mkdir(HUB_OUT, { recursive: true })

const startedAt = new Date().toISOString()
const sha = (value) => createHash('sha256').update(String(value)).digest('hex')
const iso = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.error('[p3-drive]', ...args)

async function fetchJson(url, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'x-orchestrator-request': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  return { status: response.status, body: parsed }
}

async function waitFor(check, { timeoutMs = 30000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

function pidOn(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  const line = String(result.stdout ?? '').trim().split('\n').filter(Boolean)[0]
  return line ? Number(line) : null
}

function count(text, pattern) {
  return (String(text).match(pattern) ?? []).length
}

async function livisState() {
  try {
    const { status, body } = await fetchJson(`http://127.0.0.1:${LIVIS_PORT}/orchestrator/api/state`, { timeoutMs: 2000 })
    return status === 200 ? body : null
  } catch {
    return null
  }
}

async function mainState() {
  try {
    const { status, body } = await fetchJson(`http://127.0.0.1:${MAIN_PORT}/orchestrator/api/state`, { timeoutMs: 2000 })
    return status === 200 ? body : null
  } catch {
    return null
  }
}

function dshBin() {
  const found = spawnSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' })
  return String(found.stdout ?? '').trim() || 'dsh'
}

async function tmuxRestart({ stamp, env }) {
  const began = Date.now()
  const oldPid = pidOn(LIVIS_PORT)
  const kill = spawnSync('tmux', ['kill-session', '-t', 'dsh-livis'], { encoding: 'utf8' })
  try {
    await waitFor(() => !pidOn(LIVIS_PORT), { timeoutMs: 10000, label: 'livis port release' })
  } catch {
    const stuck = pidOn(LIVIS_PORT)
    if (stuck) spawnSync('kill', ['-TERM', String(stuck)])
    await waitFor(() => !pidOn(LIVIS_PORT), { timeoutMs: 8000, label: 'livis port release after TERM' })
  }
  const logPath = join(REPO, '.artifacts', `dsh-livis-${stamp}.log`)
  const envPrefix = Object.entries(env ?? {}).map(([key, value]) => `${key}='${value}'`).join(' ')
  const command = `umask 077; exec ${envPrefix ? `env ${envPrefix} ` : ''}${dshBin()} --profile livis --no-open >> ${logPath} 2>&1`
  const start = spawnSync('tmux', ['new-session', '-d', '-s', 'dsh-livis', '-n', 'server', '-c', REPO, command], { encoding: 'utf8' })
  if (start.status !== 0) throw new Error(`tmux start failed: ${start.stderr}`)
  const state = await waitFor(async () => {
    const value = await livisState()
    const health = value?.health?.livis
    return health && health.state !== 'starting' ? value : null
  }, { timeoutMs: 60000, intervalMs: 500, label: 'livis health after restart' })
  if (existsSync(logPath)) {
    await waitFor(async () => /registered SourceKind "livis"/.test(await readFile(logPath, 'utf8')), {
      timeoutMs: 5000, intervalMs: 200, label: 'registration log line',
    }).catch(() => {})
  }
  const text = existsSync(logPath) ? await readFile(logPath, 'utf8') : ''
  return {
    stamp,
    command: `tmux new-session -d -s dsh-livis -n server -c ${REPO} "umask 077; exec env <fake-relay-env> ${dshBin()} --profile livis --no-open >> ${logPath} 2>&1"`,
    oldPid,
    newPid: pidOn(LIVIS_PORT),
    masterId: state.masterId ?? null,
    health: state.health?.livis ?? null,
    logPath,
    registrationCount: count(text, /registered SourceKind "livis"/g),
    unregistrationCount: count(text, /unregistered SourceKind "livis"/g),
    duplicateErrorCount: count(text, /already registered/g),
    crashLines: text.split('\n').filter((line) => /uncaught|unhandled|fatal|Error:/.test(line)).slice(0, 5),
    elapsedMs: Date.now() - began,
  }
}

async function runTestGate(id, pattern) {
  const began = Date.now()
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`], {
    cwd: PLUGIN,
    encoding: 'utf8',
    timeout: 120000,
  })
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const pass = Number((stdout.match(/ℹ pass (\d+)/) ?? [])[1] ?? 0)
  const fail = Number((stdout.match(/ℹ fail (\d+)/) ?? [])[1] ?? 0)
  const ok = result.status === 0 && fail === 0 && pass > 0
  const assertion = pattern === 'G3-1'
    ? 'G3-1: inbound becomes a direct livis Trigger with thread/address and an unbound actor is filtered'
    : pattern === 'G3-2'
      ? 'G3-2: engine acknowledgement is consumed locally and never reaches the relay; duplicate ack/notice are dropped'
      : pattern === 'G3-4'
        ? 'G3-4: a filtered job emits exactly one fallback after the timeout and a late reply is dropped'
        : 'G3-5: concurrent jobs stay isolated and a restart never duplicates a final'
  await writeFile(join(EVID, `${id}.json`), JSON.stringify({
    id,
    command: `${process.execPath} --test --test-name-pattern=${pattern} (cwd ${PLUGIN})`,
    exitCode: result.status,
    startedAt: new Date(began).toISOString(),
    durationMs: Date.now() - began,
    stdoutSha256: sha(stdout),
    assertion,
    result: ok ? 'pass' : 'fail',
    details: { pass, fail, outputTail: stdout.split('\n').slice(-18).join('\n') },
    notes: ['Unit test uses the fake relay; no real Livis network access.'],
  }, null, 2))
  if (!ok) throw new Error(`${id} failed`)
  return { id, ok, stdout }
}

async function readSettings() {
  const { status, body } = await fetchJson(`http://127.0.0.1:${LIVIS_PORT}/orchestrator/api/settings`)
  if (status !== 200) throw new Error(`settings read failed: ${status}`)
  return body
}

async function saveSettings(block, value, revision) {
  const { status, body } = await fetchJson(`http://127.0.0.1:${LIVIS_PORT}/orchestrator/api/settings/${block}`, {
    method: 'PUT',
    body: { value, revision },
  })
  if (status !== 200) throw new Error(`settings ${block} save failed: ${status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

async function hubStatus() {
  return (await fetchJson(`http://127.0.0.1:${HUB_CONTROL}/status`)).body
}
async function hubTranscript() {
  return (await fetchJson(`http://127.0.0.1:${HUB_CONTROL}/transcript`)).body
}

function latestLog() {
  return [...(existsSync(join(REPO, '.artifacts')) ? [] : [])]
}

async function runG33(restarts) {
  const began = Date.now()
  const original = await readSettings()
  const originalPolicy = original.blocks.policy
  const originalEval = original.blocks.eval
  const settingsLog = []
  let outcome = null
  let failure = null
  try {
    const policyValue = structuredClone(originalPolicy.value)
    policyValue.sources ??= {}
    policyValue.sources.livis ??= {}
    policyValue.sources.livis.allowed ??= []
    if (!policyValue.sources.livis.allowed.some((actor) => actor.id === FAKE_ACTOR)) {
      policyValue.sources.livis.allowed.push({ id: FAKE_ACTOR, name: 'P3 Test User' })
    }
    const policySaved = await saveSettings('policy', policyValue, originalPolicy.revision)
    settingsLog.push({ block: 'policy', revision: policySaved.revision ?? null, allowed: policyValue.sources.livis.allowed })
    const evalValue = { ...originalEval.value, mode: 'auto' }
    const evalSaved = await saveSettings('eval', evalValue, originalEval.revision)
    settingsLog.push({ block: 'eval', revision: evalSaved.revision ?? null, mode: 'auto' })
    await waitFor(async () => (await livisState())?.health?.livis?.state === 'ready', {
      timeoutMs: 20000, intervalMs: 500, label: 'livis health after settings change',
    })
    await sleep(300)

    const jobId = `p3-g3-3-${Date.now()}`
    const msgId = `p3-msg-${Date.now()}`
    const content = '只回答 pong（不要修改文件）'
    const send = await fetchJson(`http://127.0.0.1:${HUB_CONTROL}/send`, {
      method: 'POST',
      body: { jobId, msgId, content, fromNodeId: FAKE_ACTOR },
    })
    if (send.status !== 200) throw new Error(`hub send failed: ${send.status}`)
    const deadline = Date.now() + 240000
    let result = null
    let status = null
    while (Date.now() < deadline) {
      status = await hubStatus()
      result = status.results.find((item) => item.jobId === jobId && item.text !== null) ?? null
      if (result) break
      await sleep(1000)
    }
    await waitFor(async () => {
      const current = existsSync(LIVIS_JOURNAL) ? JSON.parse(await readFile(LIVIS_JOURNAL, 'utf8')) : { jobs: {} }
      return current.jobs?.[jobId]?.status === 'final'
    }, { timeoutMs: 5000, intervalMs: 200, label: 'job journal final' }).catch(() => {})
    const sendFrames = (await hubTranscript()).frames.filter((entry) => entry.frame?.type === 'send_result'
      && entry.frame?.metadata?.job_id === jobId)
    const autoAckFrames = (await hubTranscript()).frames.filter((entry) => entry.frame?.type === 'ack_send_message'
      && entry.frame?.metadata?.job_id === jobId)
    const journal = existsSync(LIVIS_JOURNAL) ? JSON.parse(await readFile(LIVIS_JOURNAL, 'utf8')) : { jobs: {} }
    const job = journal.jobs?.[jobId] ?? null
    const logText = restarts?.at(-1)?.logPath && existsSync(restarts.at(-1).logPath)
      ? await readFile(restarts.at(-1).logPath, 'utf8') : ''
    const acceptedLog = logText.includes(`job ${jobId} accepted`)
    const finalLog = logText.includes(`job ${jobId} final reply delivered`)
    const checks = {
      resultArrived: !!result,
      resultContainsPong: !!result && /pong/i.test(String(result.text)),
      exactlyOneFinal: sendFrames.length === 1,
      protocolAutoAckObserved: autoAckFrames.length === 1,
      journalFinal: job?.status === 'final',
      journalReplyKind: job?.resultKind === 'reply',
      finalDeliveredLog: finalLog,
    }
    outcome = {
      jobId, msgId, content,
      result: result ? { text: result.text, at: result.at } : null,
      sendResultFrameCount: sendFrames.length,
      protocolAutoAckFrames: autoAckFrames.length,
      journal: job,
      engineAckConsumedLog: acceptedLog,
      logEvidence: { acceptedLog, finalLog, logPath: restarts?.at(-1)?.logPath ?? null },
      checks,
      statusFrameCounts: status?.frameCounts ?? null,
    }
    if (!Object.values(checks).every(Boolean)) {
      failure = new Error(`G3-3 checks failed: ${Object.entries(checks).filter(([, value]) => !value).map(([key]) => key).join(', ')}`)
    }
  } catch (error) {
    failure = error
  } finally {
    // Restore the isolated profile's settings, keeping the original values.
    try {
      const current = await readSettings()
      await saveSettings('eval', originalEval.value, current.blocks.eval.revision)
      await saveSettings('policy', originalPolicy.value, current.blocks.policy.revision)
      settingsLog.push({ restored: true, eval: originalEval.revision, policy: originalPolicy.revision })
    } catch (error) {
      settingsLog.push({ restored: false, error: String(error?.message ?? error) })
    }
  }
  const transcriptPath = join(EVID, 'fake-hub-transcript.jsonl')
  const snapshot = await hubTranscript()
  await writeFile(transcriptPath, snapshot.frames.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await writeFile(join(EVID, 'V3-3.json'), JSON.stringify({
    id: 'V3-3',
    command: `node scripts/p3-drive.mjs -> hub ${HUB_CONTROL} send_message "${'只回答 pong（不要修改文件）'}" against livis 3083`,
    exitCode: failure ? 1 : 0,
    startedAt: new Date(began).toISOString(),
    durationMs: Date.now() - began,
    stdoutSha256: sha(JSON.stringify(outcome ?? {})),
    assertion: 'G3-3: one real-router final response contains pong, exactly one send_result frame, and the single protocol auto-ack is not an engine acknowledgement',
    result: failure ? 'fail' : 'pass',
    details: { outcome, failure: failure ? String(failure.message ?? failure) : null, settings: settingsLog, transcriptPath },
    notes: ['The only message sent through the real livis router in P3. Eval mode was temporarily auto and the fake actor was bound in the isolated livis profile policy; both were restored afterwards. No superagent prompt was changed.'],
  }, null, 2))
  return { failure, outcome, transcriptPath }
}

async function runV36(restarts, g33) {
  const began = Date.now()
  const main = await mainState()
  const mainPid = pidOn(MAIN_PORT)
  const mainPackage = existsSync(join(MAIN_PROFILE, 'package.json')) ? await readFile(join(MAIN_PROFILE, 'package.json'), 'utf8') : ''
  const mainPatch = existsSync(join(MAIN_PROFILE, 'cordis.patch.yml')) ? await readFile(join(MAIN_PROFILE, 'cordis.patch.yml'), 'utf8') : ''
  const mainNodeModules = existsSync(join(MAIN_PROFILE, 'node_modules', 'dsh-livis-source'))
  const artifacts = existsSync(join(REPO, '.artifacts')) ? await readdir(join(REPO, '.artifacts')) : []
  const mainLogs = artifacts.filter((name) => /^dsh-superagent-superagent-.*\.log$/.test(name)).sort()
  const mainLog = mainLogs.length ? await readFile(join(REPO, '.artifacts', mainLogs.at(-1)), 'utf8') : ''
  const latestLivisLog = restarts.at(-1)?.logPath ?? null
  const livisLog = latestLivisLog && existsSync(latestLivisLog) ? await readFile(latestLivisLog, 'utf8') : ''
  const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  const protocolGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: PROTOCOL, encoding: 'utf8' })
  const protocolIsGit = protocolGit.status === 0 && String(protocolGit.stdout ?? '').trim() === 'true'
  const fullTests = spawnSync(process.execPath, ['--test'], { cwd: PLUGIN, encoding: 'utf8', timeout: 120000 })
  const fullTestOut = `${fullTests.stdout ?? ''}${fullTests.stderr ?? ''}`
  const checks = {
    mainHealthy: main?.health?.runtime?.state === 'ready',
    mainHasNoLivisHealth: !!main && !('livis' in (main.health ?? {})),
    mainPidPresent: typeof mainPid === 'number',
    mainProfilePackageClean: !/livis/i.test(mainPackage),
    mainProfilePatchClean: !/livis/i.test(mainPatch),
    mainNodeModulesNoLivis: !mainNodeModules,
    mainLogNoLivis: !/livis/i.test(mainLog),
    repoClean: String(gitStatus.stdout ?? '').trim() === '',
    pluginTestsPass: fullTests.status === 0 && /ℹ fail 0/.test(fullTestOut),
    twoRestartsNoDuplicate: restarts.every((item) => item.registrationCount === 1 && item.unregistrationCount === 0 && item.duplicateErrorCount === 0),
    twoRestartsHealthy: restarts.every((item) => item.health?.state === 'ready'),
    livisLogHasSingleRegistration: count(livisLog, /registered SourceKind "livis"/g) === 1,
  }
  const failure = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
  await writeFile(join(EVID, 'V3-6.json'), JSON.stringify({
    id: 'V3-6',
    command: 'node scripts/p3-drive.mjs -> main 3082 health, profile/log scan, git status, node --test',
    exitCode: failure.length ? 1 : 0,
    startedAt: new Date(began).toISOString(),
    durationMs: Date.now() - began,
    stdoutSha256: sha(JSON.stringify({ checks, mainPid })),
    assertion: 'G3-6: main 3082 remains healthy and livis-free, the superagent repo is clean, the plugin tests pass, and two livis restarts register exactly once',
    result: failure.length ? 'fail' : 'pass',
    details: {
      checks,
      failures: failure,
      main: { pid: mainPid, health: main?.health?.runtime ?? null, healthKeys: Object.keys(main?.health ?? {}) },
      restarts,
      latestLivisLog: latestLivisLog ? latestLivisLog.split('/').at(-1) : null,
      mainLog: mainLogs.at(-1) ?? null,
      gitStatus: String(gitStatus.stdout ?? ''),
      protocolProject: { path: PROTOCOL, isGitCheckout: protocolIsGit, note: protocolIsGit ? undefined : 'P2 project has no git baseline; it was only read by this driver' },
      pluginTests: { exitCode: fullTests.status, tail: fullTestOut.split('\n').slice(-16).join('\n') },
      g33: g33?.outcome ?? null,
    },
    notes: ['Main profile was only read. .artifacts is gitignored.'],
  }, null, 2))
  return { checks, failure, mainPid }
}

// ---------------------------------------------------------------------- main

let hub = null
const restarts = []
try {
  if (existsSync(join(HUB_OUT, 'hub.json'))) {
    // A previous daemon may still be alive; refuse to silently reuse it.
    const previous = await fetchJson(`http://127.0.0.1:${HUB_CONTROL}/status`).catch(() => null)
    if (previous?.status === 200) throw new Error('control port 3091 already in use by an old fake hub; stop it first')
  }
  await rm(join(HUB_OUT, 'hub.json'), { force: true })
  hub = spawn(process.execPath, [join(PLUGIN, 'scripts', 'p3-hub.mjs'), '--out', HUB_OUT, '--control-port', String(HUB_CONTROL)], {
    cwd: PLUGIN,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  hub.stdout.on('data', (chunk) => process.stderr.write(`[p3-hub:out] ${chunk}`))
  hub.stderr.on('data', (chunk) => process.stderr.write(`[p3-hub:err] ${chunk}`))
  const hubInfo = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(join(HUB_OUT, 'hub.json'), 'utf8'))
    } catch {
      return null
    }
  }, { timeoutMs: 15000, label: 'fake hub start' })
  const hubReady = await waitFor(async () => (await fetchJson(`http://127.0.0.1:${HUB_CONTROL}/status`)).status === 200, {
    timeoutMs: 10000, label: 'fake hub control',
  })
  const env = {
    DSH_LIVIS_WS_URL: hubInfo.urls.ws,
    DSH_LIVIS_HTTP_URL: hubInfo.urls.http,
    DSH_LIVIS_IDAAS_ENDPOINT: hubInfo.urls.idaas,
    DSH_LIVIS_REFRESH_TOKEN: FAKE_REFRESH,
  }
  log('fake hub', hubInfo.urls)

  const stamp1 = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-r1`
  restarts.push(await tmuxRestart({ stamp: stamp1, env }))
  log('restart1', restarts.at(-1).newPid, restarts.at(-1).health)
  const stamp2 = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-r2`
  restarts.push(await tmuxRestart({ stamp: stamp2, env }))
  log('restart2', restarts.at(-1).newPid, restarts.at(-1).health)

  await runTestGate('V3-1', 'G3-1')
  await runTestGate('V3-2', 'G3-2')
  await runTestGate('V3-4', 'G3-4')
  await runTestGate('V3-5', 'G3-5')

  const g33 = await runG33(restarts)
  log('g3-3', g33.failure ? `FAIL: ${g33.failure.message}` : 'pass')

  const v36 = await runV36(restarts, g33)
  log('v3-6', v36.failure.length ? `FAIL: ${v36.failure.join(', ')}` : 'pass')

  // Leave the isolated profile in its normal (no fake relay) state. The fake
  // IDaaS refresh token used by the probe is test data; remove it so a normal
  // boot reports `paused` (authorization required) instead of failing a real
  // token refresh.
  try {
    const fakeClientState = join(LIVIS_STATE, 'livis-source', 'client', 'state.json')
    if (existsSync(fakeClientState)) {
      const stored = await readFile(fakeClientState, 'utf8')
      if (stored.includes('FAKE_REFRESH_TOKEN')) await rm(join(LIVIS_STATE, 'livis-source', 'client'), { recursive: true, force: true })
    }
    const stampFinal = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-normal`
    const final = await tmuxRestart({ stamp: stampFinal, env: {} })
    log('final normal restart', final.newPid, final.health)
    await writeFile(join(EVID, 'profile-restored.json'), JSON.stringify({ finalRestart: final, at: iso() }, null, 2))
  } catch (error) {
    log('final normal restart failed:', error.message)
  }

  if (g33.failure || v36.failure.length) process.exitCode = 1
} catch (error) {
  log('driver failure:', error?.stack ?? error)
  await writeFile(join(EVID, 'driver-failure.json'), JSON.stringify({ at: iso(), error: String(error?.stack ?? error) }, null, 2))
  process.exitCode = 1
} finally {
  if (hub && !hub.killed) {
    try {
      await fetchJson(`http://127.0.0.1:${HUB_CONTROL}/close`, { method: 'POST', body: {} }).catch(() => null)
    } catch {
      // ignore
    }
    await sleep(400)
    hub.kill('SIGTERM')
  }
  log('done in', Date.now() - new Date(startedAt).getTime(), 'ms')
}
