/**
 * Durable job journal for the Livis Source.
 *
 * The journal is the plugin's own dedupe and recovery record. It is separate
 * from the protocol client's completed-result cache on purpose: the protocol
 * guarantees delivery at-least-once, while the plugin guarantees exactly one
 * logical final per job (one engine reply or one fallback).
 *
 * File: <stateDir>/jobs.json, mode 0600, replaced atomically.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const JOURNAL_VERSION = 1
const TERMINAL = new Set(['final', 'canceled', 'failed'])

/**
 * @param {{stateDir: string, logger?: {warn?: Function}, maxJobs?: number}} options
 */
export function createJobStore({ stateDir, logger = null, maxJobs = 500 }) {
  const file = join(stateDir, 'jobs.json')
  /** @type {Map<string, any>} */
  let jobs = new Map()
  let writes = Promise.resolve()
  let loaded = false

  const warn = (...args) => {
    try {
      logger?.warn?.(...args)
    } catch {
      // Logging must never affect job handling.
    }
  }

  async function ensureDir() {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await chmod(stateDir, 0o700).catch(() => {})
  }

  async function load() {
    if (loaded) return jobs
    await ensureDir()
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === JOURNAL_VERSION && parsed.jobs && typeof parsed.jobs === 'object') {
        jobs = new Map(Object.entries(parsed.jobs))
      } else {
        warn('dsh-livis-source: ignoring an unrecognized jobs journal')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('dsh-livis-source: could not read the jobs journal:', error?.message)
    }
    loaded = true
    return jobs
  }

  async function flush() {
    await ensureDir()
    const body = JSON.stringify({
      version: JOURNAL_VERSION,
      updatedAt: new Date().toISOString(),
      jobs: Object.fromEntries(jobs),
    })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600).catch(() => {})
  }

  function remember(job) {
    jobs.set(job.jobId, job)
    if (jobs.size > maxJobs) {
      for (const [id, candidate] of jobs) {
        if (jobs.size <= maxJobs) break
        if (TERMINAL.has(candidate.status)) jobs.delete(id)
      }
    }
    writes = writes.catch(() => {}).then(flush)
    return writes
  }

  return {
    file,
    load,
    get(jobId) {
      return jobs.get(String(jobId))
    },
    remember,
    put: remember,
    list() {
      return [...jobs.values()]
    },
    size() {
      return jobs.size
    },
    flush,
  }
}
