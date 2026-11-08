/**
 * Token redaction.
 *
 * Everything this library logs (or exposes through diagnostics) goes through
 * a Redactor. Secrets are registered explicitly (access tokens, refresh
 * tokens, device codes) and common token shapes are scrubbed structurally so
 * an accidental `logger.info({ token })` never leaks a credential.
 */

export const REDACTED = '[REDACTED]';

const SECRET_KEY_RE =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|client[_-]?secret|password|secret|device[_-]?code)$/i;

const BEARER_RE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{6,})/gi;
const JSON_SECRET_VALUE_RE =
  /("(?:access[_-]?token|refresh[_-]?token|accessToken|refreshToken|id[_-]?token|token|device[_-]?code|client[_-]?secret)"\s*:\s*")[^"]*(")/gi;
const QUERY_SECRET_RE = /([?&](?:token|access_token|refresh_token|device_code)=)[^&#\s]*/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const MAX_DEPTH = 6;

export class Redactor {
  constructor(initialSecrets = []) {
    /** @type {Set<string>} */
    this.secrets = new Set();
    this.register(...initialSecrets);
  }

  /**
   * Register literal secret values. Values shorter than 6 characters are
   * ignored (too likely to be a substring of benign text).
   * @param {...(string|null|undefined)} values
   */
  register(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.length >= 6) this.secrets.add(value);
    }
    return this;
  }

  /**
   * Walk an object and register every value stored under a secret-looking key.
   * @param {unknown} value
   * @param {number} [depth]
   */
  registerTokens(value, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return this;
    if (Array.isArray(value)) {
      for (const item of value) this.registerTokens(item, depth + 1);
      return this;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key) && typeof entry === 'string') this.register(entry);
      else if (entry && typeof entry === 'object') this.registerTokens(entry, depth + 1);
    }
    return this;
  }

  /**
   * @param {unknown} input
   * @returns {string}
   */
  redactString(input) {
    let out = String(input);
    // Longest first so overlapping secrets cannot leave a suffix behind.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED);
    }
    return out
      .replace(BEARER_RE, `$1${REDACTED}`)
      .replace(JSON_SECRET_VALUE_RE, `$1${REDACTED}$2`)
      .replace(QUERY_SECRET_RE, `$1${REDACTED}`)
      .replace(JWT_RE, REDACTED);
  }

  /**
   * Deep-redacted structural clone safe for logs. Never returns live secrets.
   * @param {unknown} value
   * @param {number} [depth]
   * @param {WeakSet<object>} [seen]
   * @returns {unknown}
   */
  redactValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === 'string') return this.redactString(value);
    if (type === 'number' || type === 'boolean' || type === 'bigint') return value;
    if (type === 'function') return '[Function]';
    if (type === 'symbol') return String(value);

    if (value instanceof Error) {
      return {
        name: value.name,
        code: value.code,
        message: this.redactString(value.message),
        stack: value.stack ? this.redactString(value.stack) : undefined,
      };
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
    if (value instanceof URL) return this.redactString(value.toString());

    if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => this.redactValue(item, depth + 1, seen));

    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key) && entry !== null && entry !== undefined) {
        out[key] = REDACTED;
      } else {
        out[key] = this.redactValue(entry, depth + 1, seen);
      }
    }
    return out;
  }

  /** @param {Error} error */
  redactError(error) {
    return this.redactValue(error);
  }
}

/** @param {...(string|null|undefined)} secrets */
export function createRedactor(...secrets) {
  return new Redactor(secrets);
}

const NOOP = () => {};

/**
 * Wrap any console-like logger so every argument is redacted and logger
 * failures can never break protocol handling.
 *
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [sink]
 * @param {Redactor} [redactor]
 * @param {{level?: 'debug'|'info'|'warn'|'error'}} [options]
 */
export function wrapLogger(sink = console, redactor = new Redactor(), options = {}) {
  const order = ['debug', 'info', 'warn', 'error'];
  const threshold = Math.max(0, order.indexOf(options.level ?? 'info'));
  /** @type {Record<string, Function>} */
  const logger = {};
  for (const [index, level] of order.entries()) {
    logger[level] = (...args) => {
      if (index < threshold) return;
      try {
        const fn = typeof sink?.[level] === 'function' ? sink[level] : sink?.log;
        if (typeof fn !== 'function') return;
        fn.apply(sink, args.map((arg) => redactor.redactValue(arg)));
      } catch {
        // Logging must never affect protocol behavior.
      }
    };
  }
  logger.child = () => logger;
  logger.redactor = redactor;
  return logger;
}

export function createSilentLogger() {
  return {
    debug: NOOP,
    info: NOOP,
    warn: NOOP,
    error: NOOP,
    child() {
      return this;
    },
  };
}

/**
 * Collects redacted log lines; used by tests and by P3 for diagnostics.
 * @param {Redactor} [redactor]
 */
export function createMemoryLogger(redactor = new Redactor()) {
  /** @type {{level: string, line: string, at: number}[]} */
  const entries = [];
  const sink = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    sink[level] = (...args) => {
      entries.push({
        level,
        line: args
          .map((arg) =>
            typeof arg === 'string'
              ? redactor.redactString(arg)
              : JSON.stringify(redactor.redactValue(arg)),
          )
          .join(' '),
        at: Date.now(),
      });
    };
  }
  const logger = wrapLogger(sink, redactor);
  logger.entries = entries;
  logger.text = () => entries.map((e) => `${e.level}: ${e.line}`).join('\n');
  return logger;
}
