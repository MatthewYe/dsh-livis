/**
 * Durable state: refresh token, stable agent/device identity, and a bounded
 * cache of completed results (for at-least-once replay).
 *
 * Security properties:
 *  - state directory is created/forced to 0700 and must not be a symlink
 *  - state file is written atomically (O_CREAT|O_EXCL temp file -> fsync ->
 *    rename -> chmod) with mode 0600
 *  - reads reject symlinks, files with group/other permission bits, and files
 *    owned by another uid
 *  - the access token is never persisted (memory only)
 */

import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  LIVIS_WIRE,
  RELAY_POLICY,
  STATE_DIR_MODE,
  STATE_FILE_MODE,
  STATE_FILE_NAME,
} from './constants.js';
import { LivisConfigError, LivisStateError, LivisStateSecurityError } from './errors.js';

const POSIX = process.platform !== 'win32';
const ENOENT = 'ENOENT';

function octal(mode) {
  return `0o${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * Create a directory (if needed) and force 0700, rejecting symlinks.
 * @param {string} dir absolute directory path
 */
export async function ensureSecureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  const stat = await fsp.lstat(dir);
  if (stat.isSymbolicLink()) {
    throw new LivisStateSecurityError(`state directory ${dir} must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new LivisStateSecurityError(`state path ${dir} is not a directory`);
  }
  if (POSIX) {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new LivisStateSecurityError(`state directory ${dir} is owned by another user`);
    }
    await fsp.chmod(dir, STATE_DIR_MODE);
  }
  return dir;
}

/**
 * Read and validate a JSON state file. Returns `fallback` when absent.
 *
 * @param {string} filePath
 * @param {unknown} [fallback]
 */
export async function readJsonFile(filePath, fallback = null) {
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === ENOENT) return fallback;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new LivisStateSecurityError(`state file ${filePath} must not be a symlink`);
  }
  if (!stat.isFile()) {
    throw new LivisStateError(`state path ${filePath} is not a regular file`);
  }
  if (POSIX) {
    if ((stat.mode & 0o077) !== 0) {
      throw new LivisStateSecurityError(
        `state file ${filePath} has insecure permissions ${octal(stat.mode)} (expected 0o600)`,
      );
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new LivisStateSecurityError(`state file ${filePath} is owned by another user`);
    }
  }
  const text = await fsp.readFile(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LivisStateError(`state file ${filePath} is not valid JSON`, { cause: error });
  }
}

/**
 * Atomically write a JSON file with 0600 permissions.
 * @param {string} filePath
 * @param {unknown} value
 */
export async function atomicWriteJson(filePath, value) {
  const dir = dirname(filePath);
  await ensureSecureDir(dir);

  // Refuse to write through a symlink.
  try {
    const existing = await fsp.lstat(filePath);
    if (existing.isSymbolicLink()) {
      throw new LivisStateSecurityError(`state file ${filePath} must not be a symlink`);
    }
  } catch (error) {
    if (error?.code !== ENOENT) throw error;
  }

  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, STATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tempPath, filePath);
    await fsp.chmod(filePath, STATE_FILE_MODE);
    // Best-effort directory fsync so the rename itself is durable.
    try {
      const dirHandle = await fsp.open(dir, 'r');
      await dirHandle.sync();
      await dirHandle.close();
    } catch {
      // Some filesystems do not allow fsync on directories.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function freshState() {
  return {
    version: 1,
    refreshToken: null,
    agentId: null,
    deviceId: null,
    completedResults: [],
    updatedAt: 0,
  };
}

function normalizeCompleted(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.jobId !== 'string' || entry.jobId === '') return null;
  if (typeof entry.result !== 'string' || entry.result === '') return null;
  return {
    jobId: entry.jobId,
    result: entry.result,
    completedAt: Number.isFinite(entry.completedAt) ? entry.completedAt : 0,
  };
}

function normalizeState(raw) {
  const state = freshState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  if (typeof raw.refreshToken === 'string' && raw.refreshToken !== '') {
    state.refreshToken = raw.refreshToken;
  }
  if (typeof raw.agentId === 'string' && raw.agentId !== '') state.agentId = raw.agentId;
  if (typeof raw.deviceId === 'string' && raw.deviceId !== '') state.deviceId = raw.deviceId;
  if (Array.isArray(raw.completedResults)) {
    for (const entry of raw.completedResults) {
      const normalized = normalizeCompleted(entry);
      if (normalized) state.completedResults.push(normalized);
    }
  }
  if (Number.isFinite(raw.updatedAt)) state.updatedAt = raw.updatedAt;
  return state;
}

/**
 * @param {{
 *   stateDir: string,
 *   maxCompletedResults?: number,
 * }} options
 */
export function createStateStore(options = {}) {
  if (!options.stateDir || typeof options.stateDir !== 'string') {
    throw new LivisConfigError('createStateStore requires an absolute stateDir');
  }
  const dir = resolve(options.stateDir);
  const filePath = join(dir, STATE_FILE_NAME);
  const maxCompleted = Math.min(
    1000,
    Math.max(1, Number(options.maxCompletedResults ?? RELAY_POLICY.completedResultCacheSize)),
  );

  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  /** Serialize all mutations so concurrent callers cannot lose updates. */
  function enqueue(fn) {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  }

  async function readUnsafe() {
    const raw = await readJsonFile(filePath, null);
    return normalizeState(raw);
  }

  async function writeUnsafe(state) {
    const out = {
      version: 1,
      refreshToken: state.refreshToken,
      agentId: state.agentId,
      deviceId: state.deviceId,
      completedResults: state.completedResults.slice(-maxCompleted),
      updatedAt: Date.now(),
    };
    await atomicWriteJson(filePath, out);
    return out;
  }

  const store = {
    stateDir: dir,
    statePath: filePath,
    maxCompletedResults: maxCompleted,

    async init() {
      await ensureSecureDir(dir);
      await readUnsafe();
      return store;
    },

    async read() {
      return readUnsafe();
    },

    /**
     * Resolve stable identities. Explicit values win; otherwise previously
     * persisted ids are reused; otherwise new ids are generated once.
     * @param {{agentId?: string, deviceId?: string, agentIdPrefix?: string, deviceIdPrefix?: string}} [input]
     */
    async ensureIdentity(input = {}) {
      return enqueue(async () => {
        const state = await readUnsafe();
        let changed = false;

        const explicitAgent = typeof input.agentId === 'string' ? input.agentId.trim() : '';
        if (explicitAgent) {
          if (state.agentId !== explicitAgent) {
            state.agentId = explicitAgent;
            changed = true;
          }
        } else if (!state.agentId) {
          state.agentId = `${input.agentIdPrefix ?? LIVIS_WIRE.agentIdPrefix}${randomUUID()}`;
          changed = true;
        }

        const explicitDevice = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
        if (explicitDevice) {
          if (state.deviceId !== explicitDevice) {
            state.deviceId = explicitDevice;
            changed = true;
          }
        } else if (!state.deviceId) {
          state.deviceId = `${input.deviceIdPrefix ?? LIVIS_WIRE.deviceIdPrefix}${randomUUID()}`;
          changed = true;
        }

        if (changed || !state.updatedAt) await writeUnsafe(state);
        return { agentId: state.agentId, deviceId: state.deviceId };
      });
    },

    async getRefreshToken() {
      const state = await readUnsafe();
      return state.refreshToken;
    },

    /** @param {string|null} token */
    async setRefreshToken(token) {
      if (token !== null && (typeof token !== 'string' || token === '')) {
        throw new LivisStateError('refresh token must be a non-empty string or null');
      }
      return enqueue(async () => {
        const state = await readUnsafe();
        state.refreshToken = token;
        await writeUnsafe(state);
        return token;
      });
    },

    async clearTokens() {
      return enqueue(async () => {
        const state = await readUnsafe();
        state.refreshToken = null;
        await writeUnsafe(state);
        return null;
      });
    },

    /**
     * Persist a final result BEFORE it is sent, so a duplicate inbound
     * delivery can replay the exact same bytes.
     * @param {string} jobId
     * @param {string} result nested JSON string
     */
    async rememberCompletedResult(jobId, result) {
      if (typeof jobId !== 'string' || jobId === '') {
        throw new LivisStateError('jobId is required to remember a result');
      }
      if (typeof result !== 'string' || result === '') {
        throw new LivisStateError('result must be a non-empty string');
      }
      return enqueue(async () => {
        const state = await readUnsafe();
        state.completedResults = state.completedResults.filter((entry) => entry.jobId !== jobId);
        state.completedResults.push({ jobId, result, completedAt: Date.now() });
        if (state.completedResults.length > maxCompleted) {
          state.completedResults = state.completedResults.slice(-maxCompleted);
        }
        await writeUnsafe(state);
        return result;
      });
    },

    /** @param {string} jobId @returns {Promise<string|null>} */
    async getCompletedResult(jobId) {
      const state = await readUnsafe();
      for (let index = state.completedResults.length - 1; index >= 0; index -= 1) {
        if (state.completedResults[index].jobId === jobId) {
          return state.completedResults[index].result;
        }
      }
      return null;
    },

    async listCompletedResults() {
      const state = await readUnsafe();
      return state.completedResults.map((entry) => ({ ...entry }));
    },

    async clearCompletedResults() {
      return enqueue(async () => {
        const state = await readUnsafe();
        state.completedResults = [];
        await writeUnsafe(state);
        return [];
      });
    },

    /** Secret-free snapshot for health/diagnostics. */
    async describe() {
      const state = await readUnsafe();
      return {
        agentId: state.agentId,
        deviceId: state.deviceId,
        hasRefreshToken: typeof state.refreshToken === 'string' && state.refreshToken !== '',
        completedResultCount: state.completedResults.length,
        updatedAt: state.updatedAt,
      };
    },
  };

  return store;
}
