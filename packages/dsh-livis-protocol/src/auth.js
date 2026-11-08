/**
 * IDaaS device authorization + token management.
 *
 * Implements the RFC 8628 device flow the Livis gateway expects:
 *   POST {idaas}/aux    form {client_id, scope, audience, offline_access[, prompt=login]}
 *   POST {idaas}/token  form {grant_type: device_code, device_code, client_id}
 *       -> HTTP 428 / error=authorization_pending : keep polling
 *       -> error=slow_down                         : interval += 5s
 *       -> 200 with access_token + refresh_token   : success
 *   POST {idaas}/token  form {grant_type: refresh_token, refresh_token, client_id}
 *   POST {idaas}/revoke form {token, token_type_hint: refresh_token, client_id}
 *
 * Access tokens live in memory only; the refresh token is persisted through
 * the 0600 state store and rotated on every refresh response.
 */

import { RELAY_POLICY } from './constants.js';
import {
  LivisAuthError,
  LivisAuthRequiredError,
  LivisConfigError,
  LivisHttpError,
} from './errors.js';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

function headerSafeError(value) {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const defaultSleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * POST an application/x-www-form-urlencoded body and parse a JSON response.
 * Network failures are normalised to LivisHttpError so callers can classify
 * them as transient.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   url: string,
 *   fields: Record<string, string|number|undefined|null>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} input
 */
export async function postForm(input) {
  const {
    fetchImpl,
    url,
    fields,
    signal,
    timeoutMs = RELAY_POLICY.httpTimeoutMs,
  } = input;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }

  let effectiveSignal = signal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    effectiveSignal =
      signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, timeoutSignal])
        : signal ?? timeoutSignal;
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      signal: effectiveSignal,
    });
  } catch (error) {
    throw new LivisHttpError('IDaaS request failed before receiving a response', {
      status: 0,
      code: 'LIVIS_HTTP_ERROR',
      retryable: true,
      cause: error,
    });
  }

  const text = await response.text().catch(() => '');
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  return { status: response.status, ok: response.status >= 200 && response.status < 300, data, text };
}

/**
 * @param {{
 *   idaasEndpoint: string,
 *   clientId: string,
 *   audience?: string,
 *   scope?: string,
 *   stateStore: ReturnType<typeof import('./state.js').createStateStore>,
 *   fetchImpl?: typeof fetch,
 *   logger: object,
 *   redactor: import('./redact.js').Redactor,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 * }} options
 */
export function createTokenManager(options) {
  const {
    idaasEndpoint,
    clientId,
    stateStore,
    logger,
    redactor,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = RELAY_POLICY.httpTimeoutMs,
  } = options;

  if (!idaasEndpoint) throw new LivisConfigError('idaasEndpoint is required');
  if (!clientId) throw new LivisConfigError('clientId is required');
  if (!stateStore) throw new LivisConfigError('stateStore is required');
  if (typeof fetchImpl !== 'function') {
    throw new LivisConfigError('A fetch implementation is required (config.fetch or global fetch)');
  }

  /** @type {{accessToken: string, expiresAt: number}|null} */
  let cached = null;
  /** @type {Promise<{accessToken: string, expiresAt: number}>|null} */
  let refreshInFlight = null;

  async function performRefresh(signal) {
    const refreshToken = await stateStore.getRefreshToken();
    if (!refreshToken) throw new LivisAuthRequiredError();

    const response = await postForm({
      fetchImpl,
      url: joinUrl(idaasEndpoint, 'token'),
      fields: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      },
      signal,
      timeoutMs,
    });

    if (response.status === 401) {
      await stateStore.clearTokens();
      cached = null;
      throw new LivisAuthError('Livis refresh token was rejected; a new device login is required');
    }
    if (!response.ok) {
      const errorCode = headerSafeError(response.data?.error);
      throw new LivisAuthError(
        `IDaaS token refresh failed with HTTP ${response.status}${errorCode ? ` (${errorCode})` : ''}`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const accessToken = response.data?.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new LivisAuthError('IDaaS token refresh response is missing access_token');
    }
    const rotatedRefresh = response.data?.refresh_token;
    if (typeof rotatedRefresh === 'string' && rotatedRefresh !== '') {
      await stateStore.setRefreshToken(rotatedRefresh);
      redactor.register(rotatedRefresh);
    }
    redactor.register(accessToken);

    const expiresIn = positiveNumber(response.data?.expires_in, 3600);
    cached = { accessToken, expiresAt: now() + expiresIn * 1000 };
    logger.info('Livis access token refreshed');
    return cached;
  }

  const tokenManager = {
    /** @returns {Promise<string>} */
    async getAccessToken({ force = false, signal } = {}) {
      if (!force && cached && cached.expiresAt - now() > 60_000) {
        return cached.accessToken;
      }
      return tokenManager.forceRefresh({ signal });
    },

    /** @returns {Promise<string>} */
    async forceRefresh({ signal } = {}) {
      if (!refreshInFlight) {
        refreshInFlight = performRefresh(signal).finally(() => {
          refreshInFlight = null;
        });
      }
      const token = await refreshInFlight;
      return token.accessToken;
    },

    /**
     * Cache an access token obtained by the device flow. Never persisted.
     * @param {string} accessToken
     * @param {{expiresIn?: number}} [meta]
     */
    setAccessToken(accessToken, meta = {}) {
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new LivisAuthError('Cannot cache an empty access token');
      }
      redactor.register(accessToken);
      const expiresIn = positiveNumber(meta.expiresIn, 3600);
      cached = { accessToken, expiresAt: now() + expiresIn * 1000 };
      return cached.expiresAt;
    },

    /** Secret-free token state. */
    async tokenState() {
      const refreshToken = await stateStore.getRefreshToken();
      return {
        hasRefreshToken: typeof refreshToken === 'string' && refreshToken !== '',
        hasAccessToken: cached !== null,
        accessTokenExpiresAt: cached?.expiresAt ?? null,
      };
    },

    /** @param {{clearStore?: boolean}} [opts] */
    async clear({ clearStore = true } = {}) {
      cached = null;
      if (clearStore) await stateStore.clearTokens();
    },
  };

  return tokenManager;
}

/**
 * Full device-auth facade: device flow + token manager + revoke.
 *
 * @param {{
 *   idaasEndpoint: string,
 *   clientId: string,
 *   audience: string,
 *   scope?: string,
 *   stateStore: ReturnType<typeof import('./state.js').createStateStore>,
 *   fetchImpl?: typeof fetch,
 *   logger: object,
 *   redactor: import('./redact.js').Redactor,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 * }} options
 */
export function createDeviceAuth(options) {
  const {
    idaasEndpoint,
    clientId,
    audience,
    stateStore,
    logger,
    redactor,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    sleep = defaultSleep,
    timeoutMs = RELAY_POLICY.httpTimeoutMs,
  } = options;

  if (!audience) throw new LivisConfigError('audience is required for device authorization');
  const scope = options.scope ?? 'super';

  const tokens = createTokenManager({
    idaasEndpoint,
    clientId,
    stateStore,
    logger,
    redactor,
    fetchImpl,
    now,
    timeoutMs,
  });

  async function requestDeviceCode({ force = false, signal } = {}) {
    const fields = {
      client_id: clientId,
      scope: `${scope} offline_access`,
      audience,
      offline_access: 'true',
    };
    if (force) fields.prompt = 'login';

    const response = await postForm({
      fetchImpl,
      url: joinUrl(idaasEndpoint, 'aux'),
      fields,
      signal,
      timeoutMs,
    });
    if (!response.ok) {
      const errorCode = headerSafeError(response.data?.error);
      throw new LivisAuthError(
        `IDaaS device authorization failed with HTTP ${response.status}${errorCode ? ` (${errorCode})` : ''}`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    const data = response.data ?? {};
    const deviceCode = data.device_code;
    const userCode = data.user_code;
    const verificationUri = data.verification_uri;
    if (
      typeof deviceCode !== 'string' ||
      deviceCode === '' ||
      typeof userCode !== 'string' ||
      userCode === '' ||
      typeof verificationUri !== 'string' ||
      verificationUri === ''
    ) {
      throw new LivisAuthError('IDaaS device authorization response is missing required fields');
    }
    redactor.register(deviceCode);

    const expiresIn = positiveNumber(data.expires_in, 600);
    const interval = positiveNumber(data.interval, 5);
    logger.info('Livis device authorization code acquired');
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete:
        typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : null,
      expiresIn,
      interval,
    };
  }

  /**
   * Poll the token endpoint until the user completes the device login.
   * Sleep/now are injectable so tests never wait for real time.
   */
  async function pollForToken({
    deviceCode,
    expiresIn = 600,
    interval = 5,
    signal,
    onPending,
  } = {}) {
    if (typeof deviceCode !== 'string' || deviceCode === '') {
      throw new LivisConfigError('pollForToken requires a deviceCode');
    }
    const deadline = now() + positiveNumber(expiresIn, 600) * 1000;
    let intervalMs = Math.max(1000, positiveNumber(interval, 5) * 1000);
    let transientFailures = 0;

    while (now() < deadline) {
      await sleep(intervalMs);
      if (signal?.aborted) {
        throw new LivisAuthError('Device authorization was aborted');
      }

      let response;
      try {
        response = await postForm({
          fetchImpl,
          url: joinUrl(idaasEndpoint, 'token'),
          fields: {
            grant_type: DEVICE_GRANT_TYPE,
            device_code: deviceCode,
            client_id: clientId,
          },
          signal,
          timeoutMs,
        });
      } catch (error) {
        if (!(error instanceof LivisHttpError) || !error.retryable) throw error;
        transientFailures += 1;
        if (transientFailures > RELAY_POLICY.maxAuthTransientRetries) {
          throw new LivisAuthError('IDaaS token endpoint is unreachable; device login aborted', {
            retryable: true,
            cause: error,
          });
        }
        intervalMs = Math.min(intervalMs * 2, RELAY_POLICY.maxPollIntervalMs);
        logger.warn('Livis device token poll failed transiently; backing off');
        onPending?.({ status: 0, error: 'network_error', intervalMs, at: now() });
        continue;
      }

      if (response.status === 200) {
        const data = response.data ?? {};
        const accessToken = data.access_token;
        const refreshToken = data.refresh_token;
        if (typeof accessToken !== 'string' || accessToken === '') {
          throw new LivisAuthError('IDaaS device token response is missing access_token');
        }
        if (typeof refreshToken !== 'string' || refreshToken === '') {
          throw new LivisAuthError('IDaaS device token response is missing refresh_token');
        }
        redactor.register(accessToken, refreshToken);
        await stateStore.setRefreshToken(refreshToken);
        tokens.setAccessToken(accessToken, {
          expiresIn: positiveNumber(data.expires_in, 3600),
        });
        logger.info('Livis device login completed');
        return {
          accessToken,
          refreshToken,
          expiresIn: positiveNumber(data.expires_in, 3600),
          tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
          scope: typeof data.scope === 'string' ? data.scope : undefined,
        };
      }

      const errorCode = headerSafeError(response.data?.error);

      if (response.status === 428) {
        onPending?.({ status: 428, error: 'authorization_pending', intervalMs, at: now() });
        continue;
      }

      if (response.status === 400) {
        if (errorCode === 'authorization_pending') {
          onPending?.({ status: 400, error: errorCode, intervalMs, at: now() });
          continue;
        }
        if (errorCode === 'slow_down') {
          intervalMs = Math.min(
            intervalMs + RELAY_POLICY.slowDownIncrementMs,
            RELAY_POLICY.maxPollIntervalMs,
          );
          logger.warn('IDaaS requested slow_down; polling interval increased');
          onPending?.({ status: 400, error: errorCode, intervalMs, at: now() });
          continue;
        }
        throw new LivisAuthError(
          `Device authorization failed${errorCode ? ` (${errorCode})` : ' (HTTP 400)'}`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        transientFailures += 1;
        if (transientFailures > RELAY_POLICY.maxAuthTransientRetries) {
          throw new LivisAuthError(
            `IDaaS token endpoint unavailable (HTTP ${response.status}); device login aborted`,
            { retryable: true },
          );
        }
        intervalMs = Math.min(intervalMs * 2, RELAY_POLICY.maxPollIntervalMs);
        logger.warn(`Livis device token poll got HTTP ${response.status}; backing off`);
        onPending?.({ status: response.status, error: 'transient_error', intervalMs, at: now() });
        continue;
      }

      const errorCodeForLog = errorCode ?? 'unknown_error';
      throw new LivisAuthError(
        `Device authorization failed with HTTP ${response.status} (${errorCodeForLog})`,
      );
    }

    throw new LivisAuthError('Device authorization code expired before login completed');
  }

  async function login({ force = false, onCode, onPending, signal } = {}) {
    const code = await requestDeviceCode({ force, signal });
    if (typeof onCode === 'function') await onCode({ ...code });
    const token = await pollForToken({
      deviceCode: code.deviceCode,
      expiresIn: code.expiresIn,
      interval: code.interval,
      signal,
      onPending,
    });
    return {
      ok: true,
      expiresAt: now() + token.expiresIn * 1000,
      hasRefreshToken: true,
    };
  }

  async function revoke({ signal } = {}) {
    const refreshToken = await stateStore.getRefreshToken();
    let revoked = false;
    let status = 0;
    if (refreshToken) {
      try {
        const response = await postForm({
          fetchImpl,
          url: joinUrl(idaasEndpoint, 'revoke'),
          fields: {
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: clientId,
          },
          signal,
          timeoutMs,
        });
        status = response.status;
        revoked = response.ok;
        if (!response.ok) logger.warn(`Livis token revoke returned HTTP ${response.status}`);
      } catch (error) {
        logger.warn('Livis token revoke request failed; clearing local token anyway');
      }
    }
    await tokens.clear({ clearStore: true });
    logger.info('Livis local tokens cleared');
    return { revoked, status };
  }

  return {
    ...tokens,
    requestDeviceCode,
    pollForToken,
    login,
    revoke,
    idaasEndpoint,
    clientId,
    audience,
    scope,
  };
}
