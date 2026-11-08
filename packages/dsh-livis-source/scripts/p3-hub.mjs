/**
 * Local fake Livis relay for P3 gate verification.
 *
 * Starts dsh-livis-protocol's fake hub on a random port and exposes a small
 * loopback control API (no credentials) so the drive script can deliver
 * messages, read results and snapshot a redacted transcript.
 *
 * Usage: node scripts/p3-hub.mjs --out <dir> [--control-port 3091]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createFakeHub } from 'dsh-livis-protocol/testing/fake-hub'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const outDir = arg('--out', join(process.cwd(), '.artifacts', 'verify', 'p3'))
const controlPort = Number(arg('--control-port', '3091'))
await mkdir(outDir, { recursive: true })

const SECRET_KEYS = new Set(['token', 'access_token', 'refresh_token', 'authorization', 'cookie', 'set-cookie'])
const redactString = (value) => value
  .replace(/FAKE_(?:ACCESS|REFRESH)_TOKEN_\d+/g, '<redacted-token>')
  .replace(/([?&]token=)[^&\s]+/g, '$1<redacted>')
const redactValue = (value) => {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, SECRET_KEYS.has(key.toLowerCase()) ? '<redacted>' : redactValue(entry),
    ]))
  }
  return value
}
const redactFrame = (frame) => redactValue(frame)

const hub = await createFakeHub()
const startedAt = new Date().toISOString()
const written = join(outDir, 'hub.json')
await writeFile(written, JSON.stringify({
  pid: process.pid,
  startedAt,
  urls: hub.urls,
  controlPort,
}, null, 2))

const counts = () => {
  const byType = {}
  for (const frame of hub.frames) byType[frame?.type ?? 'unknown'] = (byType[frame?.type ?? 'unknown'] ?? 0) + 1
  return byType
}
const resultsView = () => hub.results.map((entry) => {
  let text = null
  try {
    text = JSON.parse(entry.frame?.payload?.data ?? 'null')?.text ?? null
  } catch {
    text = null
  }
  return {
    jobId: entry.frame?.metadata?.job_id ?? null,
    msgId: entry.frame?.metadata?.msg_id ?? null,
    text,
    at: entry.at,
    acknowledged: entry.acked === true,
  }
})
const transcript = () => hub.frameLog.map((entry) => ({
  at: entry.at,
  connectionId: entry.connectionId,
  frame: redactFrame(entry.frame),
}))

const readBody = async (request) => {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw new Error('body too large')
  }
  return body ? JSON.parse(body) : {}
}

const json = (response, status, value) => {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

const control = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/status') {
      return json(response, 200, {
        pid: process.pid,
        startedAt,
        urls: hub.urls,
        connections: hub.connections.length,
        sockets: hub.socketCount(),
        frames: hub.frames.length,
        frameCounts: counts(),
        results: resultsView(),
      })
    }
    if (request.method === 'GET' && url.pathname === '/results') {
      return json(response, 200, { results: resultsView() })
    }
    if (request.method === 'GET' && url.pathname === '/transcript') {
      return json(response, 200, { frames: transcript() })
    }
    if (request.method === 'POST' && url.pathname === '/send') {
      const body = await readBody(request)
      const jobId = String(body.jobId ?? `job-${Date.now()}`)
      const msgId = String(body.msgId ?? `msg-${Date.now()}`)
      const content = String(body.content ?? '')
      const fromNodeId = String(body.fromNodeId ?? 'livis-p3-user')
      hub.send({
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
      })
      return json(response, 200, { sent: true, jobId, msgId, fromNodeId, content })
    }
    if (request.method === 'POST' && url.pathname === '/close') {
      json(response, 200, { closing: true })
      setTimeout(() => void shutdown(), 50)
      return
    }
    return json(response, 404, { error: 'not found' })
  } catch (error) {
    return json(response, 400, { error: String(error?.message ?? error) })
  }
})
control.listen(controlPort, '127.0.0.1')

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await writeFile(join(outDir, 'transcript.jsonl'), transcript().map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  } catch {
    // best effort
  }
  await hub.close().catch(() => {})
  control.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
console.error(`[p3-hub] urls=${hub.urls.ws} control=http://127.0.0.1:${controlPort}`)
