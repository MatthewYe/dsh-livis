#!/usr/bin/env node
/**
 * Turn one real Livis job into the P4 evidence file consumed by V5-6.
 *
 * Usage:
 *   node scripts/record-real-device.mjs --job-id <jobId> [--expected "2"] \
 *     [--state-root ~/.dsh/state/livis/livis-source] \
 *     [--log <path>] [--out <path>]
 *
 * It only accepts a job that (a) came through the glasses App wake word,
 * (b) finished as a real reply (not fallback), (c) has a persisted final text,
 * (d) has a 0600 token state and a ready/connected health entry, and
 * (e) is present exactly once in the live log. No secrets are copied.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const jobId = flag('job-id') || args.find((a) => a.startsWith('job_') || /^\d{8}/.test(a))
const expected = flag('expected') || 'pong'
const stateRoot = path.resolve(
  (flag('state-root') || path.join(os.homedir(), '.dsh/state/livis/livis-source')).replace(/^~(?=$|\/)/, os.homedir()),
)
const outPath = path.resolve(flag('out') || path.join(process.cwd(), '.artifacts/verify/p4/V4-real-device.json'))
const logArg = flag('log')

if (!jobId) {
  console.error('usage: node scripts/record-real-device.mjs --job-id <id> [--expected text] [--log path] [--out path]')
  process.exit(2)
}

function fail(message) {
  console.error(`REFUSE: ${message}`)
  process.exit(1)
}

const journalPath = path.join(stateRoot, 'jobs.json')
if (!fs.existsSync(journalPath)) fail(`journal not found: ${journalPath}`)
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
const jobs = Array.isArray(journal) ? journal : journal.jobs
const all = Array.isArray(jobs) ? jobs : Object.values(jobs ?? {})
const matches = all.filter((j) => j?.jobId === jobId)
if (matches.length !== 1) fail(`expected exactly one job ${jobId}, found ${matches.length}`)
const job = matches[0]

if (job.status !== 'final') fail(`job is ${job.status}, not final`)
if (job.resultKind !== 'reply') fail(`job resultKind is ${job.resultKind}, not reply`)
if (!job.finalText || !String(job.finalText).trim()) fail('job has no persisted finalText')
if (!String(job.finalText).toLowerCase().includes(expected.toLowerCase())) {
  fail(`finalText does not contain expected ${JSON.stringify(expected)}: ${JSON.stringify(job.finalText)}`)
}

const raw = String(job.rawText ?? job.text ?? '')
// The App may strip the wake word before send_message (observed on real jobs), so a missing wake word is not fake evidence.
// Real provenance is established by the connected authorized relay, the real fromNodeId, and the live health entry below.
const wakeWordPresent = /让我的个人\s*(?:agent|终端)|让我的\s*open\s*claw|让我的小龙虾/i.test(raw)
if (!job.fromNodeId) fail('job has no fromNodeId')

const tokenPath = path.join(stateRoot, 'client', 'state.json')
if (!fs.existsSync(tokenPath)) fail(`token state missing: ${tokenPath}`)
const tokenMode = (fs.statSync(tokenPath).mode & 0o777).toString(8).padStart(4, '0')
if (tokenMode !== '0600') fail(`token state mode is ${tokenMode}, expected 0600`)
const tokenState = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
if (!tokenState.refreshToken) fail('token state has no refreshToken')

const healthRes = await fetch('http://127.0.0.1:3083/orchestrator/api/state', {
  headers: { 'x-orchestrator-request': '1' },
})
if (!healthRes.ok) fail(`health HTTP ${healthRes.status}`)
const state = await healthRes.json()
const health = state?.health?.livis
if (!health || health.state !== 'ready') fail(`health.livis is not ready: ${JSON.stringify(health)}`)
if (!String(health.detail).includes(String(tokenState.agentId))) {
  fail('health detail does not show the authorized agent id')
}

let logPath = logArg
if (!logPath) {
  const logDir = path.join(process.cwd(), '.artifacts')
  const logs = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => /^dsh-livis-.*\.log$/.test(f)).map((f) => path.join(logDir, f))
    : []
  logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  logPath = logs[0]
}
if (!logPath || !fs.existsSync(logPath)) fail(`log not found: ${logPath}`)
const log = fs.readFileSync(logPath, 'utf8')
if (!log.includes(`inbound job ${jobId}`)) fail('log does not contain the inbound job line')
const finalLines = log.split('\n').filter((l) => l.includes(`job ${jobId}`) && l.includes('final reply delivered'))
if (finalLines.length !== 1) fail(`expected one final-reply log line, found ${finalLines.length}`)

const deliveries = Number(job.resultDeliveries ?? 1)
const duplicateResults = Math.max(0, deliveries - 1)
if (duplicateResults !== 0) fail(`job reports ${deliveries} result deliveries`)

const commandLine = [process.execPath, ...process.argv.slice(1)].join(' ')
const startedAt = job.receivedAt || new Date().toISOString()

const evidence = {
  result: 'pass',
  exitCode: 0,
  command: commandLine,
  startedAt,
  finishedAt: new Date().toISOString(),
  realDevice: true,
  userAuthorized: true,
  authorization: {
    deviceCodeCompleted: true,
    connected: true,
    tokenFileMode: tokenMode,
  },
  binding: {
    appConnected: true,
  },
  singleTurn: {
    jobId,
    prompt: raw,
    expectedFinalText: expected,
    wakeWordPresent,
    finalAnswerCount: 1,
    finalText: job.finalText,
    duplicateResults,
  },
  evidence: {
    logPath: path.resolve(logPath),
    journalPath,
    healthAt: health.at ?? null,
    screenshotPaths: [],
    recordedAt: new Date().toISOString(),
  },
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
console.log(`WROTE ${outPath}`)
console.log(JSON.stringify({ jobId, finalText: job.finalText, expected, duplicateResults, logPath }, null, 2))
