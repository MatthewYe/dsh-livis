/**
 * Error taxonomy for the Livis protocol library.
 *
 * Every error exposes a stable `code` (P3 switches on it) and a `retryable`
 * flag. Messages must NEVER contain tokens; callers may log `err.message`
 * freely. Details that could be sensitive (auth response bodies) are not
 * attached to errors.
 */

export class LivisError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, retryable?: boolean, cause?: unknown, details?: object}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'LIVIS_ERROR';
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class LivisConfigError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_CONFIG_INVALID', ...options });
  }
}

export class LivisAuthRequiredError extends LivisError {
  constructor(message = 'No Livis refresh token available; run the IDaaS device login first', options = {}) {
    super(message, { code: 'LIVIS_AUTH_REQUIRED', ...options });
  }
}

export class LivisAuthError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_AUTH_FAILED', ...options });
  }
}

export class LivisHttpError extends LivisError {
  constructor(message, { status, code = 'LIVIS_HTTP_ERROR', retryable = false, ...rest } = {}) {
    super(message, { code, retryable, ...rest });
    this.status = status;
  }
}

export class LivisProtocolError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_PROTOCOL_INVALID', ...options });
  }
}

export class LivisStateError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_STATE_INVALID', ...options });
  }
}

export class LivisStateSecurityError extends LivisStateError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_STATE_INSECURE', ...options });
  }
}

export class LivisConnectionError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_CONNECTION_FAILED', retryable: true, ...options });
  }
}

export class LivisConnectTimeoutError extends LivisError {
  constructor(message = 'Timed out waiting for the Livis relay handshake', options = {}) {
    super(message, { code: 'LIVIS_CONNECT_TIMEOUT', retryable: true, ...options });
  }
}

export class LivisNotConnectedError extends LivisError {
  constructor(message = 'Livis relay socket is not connected', options = {}) {
    super(message, { code: 'LIVIS_NOT_CONNECTED', retryable: true, ...options });
  }
}

export class LivisDisconnectedError extends LivisError {
  constructor(message = 'Livis relay socket closed while waiting for an acknowledgement', options = {}) {
    super(message, { code: 'LIVIS_DISCONNECTED', retryable: true, ...options });
  }
}

export class LivisResultNotAckedError extends LivisError {
  constructor(jobId, attempts, options = {}) {
    super(`send_result for job ${jobId} was not acknowledged after ${attempts} attempt(s)`, {
      code: 'LIVIS_RESULT_NOT_ACKED',
      retryable: true,
      details: { jobId, attempts },
      ...options,
    });
    this.jobId = jobId;
    this.attempts = attempts;
  }
}

export class LivisUploadRejectedError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_UPLOAD_REJECTED', ...options });
  }
}

export class LivisUploadError extends LivisError {
  constructor(message, options = {}) {
    super(message, { code: 'LIVIS_UPLOAD_FAILED', retryable: true, ...options });
  }
}

export class LivisStoppedError extends LivisError {
  constructor(message = 'Livis client is stopped', options = {}) {
    super(message, { code: 'LIVIS_STOPPED', ...options });
  }
}

export class LivisTimeoutError extends LivisError {
  constructor(message = 'Operation timed out', options = {}) {
    super(message, { code: 'LIVIS_TIMEOUT', retryable: true, ...options });
  }
}
