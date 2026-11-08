/**
 * File upload (skeleton + whitelist), mirroring the official Hermes client:
 *
 *   POST {httpUrl}/api/v1/files/upload
 *        ?client=hermes&job_id=...&msg_id=...&file_size=...
 *        &file_name=<stem>&file_suffix=<ext>&file_type=<mime>
 *   Authorization: Bearer <access token>
 *   multipart field "file", filename = full file name, content-type = mime
 *
 * Only whitelisted document types, only files inside the configured upload
 * root, 0 < size <= 100 MiB.
 */

import fsp from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { FILE_POLICY, LIVIS_WIRE, RELAY_POLICY } from './constants.js';
import { LivisConfigError, LivisUploadError, LivisUploadRejectedError } from './errors.js';
import { uuid } from './protocol.js';

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizeExpiry(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (Number.isFinite(value)) return value;
  return null;
}

function deriveFilePath(objectKey) {
  const parts = String(objectKey).split('/').filter(Boolean);
  if (parts.length > 2) return `/${parts.slice(1, -1).join('/')}`;
  return '/';
}

/**
 * Validate one file against the upload policy. Does not read file contents.
 *
 * @param {string} filePath
 * @param {{uploadRoot: string}} options
 */
export async function validateUploadFile(filePath, options) {
  if (!options?.uploadRoot) {
    throw new LivisConfigError('uploadRoot is required to upload files');
  }
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new LivisUploadRejectedError('file path is required');
  }
  const rootReal = await fsp.realpath(options.uploadRoot).catch(() => {
    throw new LivisUploadRejectedError('uploadRoot does not exist');
  });
  const fileReal = await fsp.realpath(resolve(filePath)).catch(() => {
    throw new LivisUploadRejectedError(`file does not exist: ${basename(filePath)}`);
  });
  if (!isInside(rootReal, fileReal)) {
    throw new LivisUploadRejectedError('file is outside the configured uploadRoot');
  }
  const stat = await fsp.stat(fileReal);
  if (!stat.isFile()) throw new LivisUploadRejectedError('upload target is not a regular file');

  const fullName = basename(fileReal);
  const suffix = extname(fullName).toLowerCase().replace(/^\./, '');
  if (!FILE_POLICY.allowedExtensions.includes(suffix)) {
    throw new LivisUploadRejectedError(
      `file type .${suffix || '(none)'} is not allowed; allowed: ${FILE_POLICY.allowedExtensions.join(', ')}`,
    );
  }
  if (stat.size <= 0) throw new LivisUploadRejectedError('file is empty');
  if (stat.size > FILE_POLICY.maxBytes) {
    throw new LivisUploadRejectedError(
      `file is larger than the ${FILE_POLICY.maxBytes} byte upload limit`,
    );
  }

  return {
    path: fileReal,
    fileName: fullName,
    name: fullName.slice(0, fullName.length - (suffix ? suffix.length + 1 : 0)),
    fileSuffix: suffix,
    fileType: FILE_POLICY.mimeTypes[suffix],
    fileSize: stat.size,
  };
}

/**
 * Build the upload URL (query params included) for one file.
 */
export function uploadUrl({ httpUrl, client, jobId, msgId, entry }) {
  const base = httpUrl.endsWith('/') ? httpUrl : `${httpUrl}/`;
  const url = new URL(LIVIS_WIRE.uploadPath.replace(/^\/+/, ''), base);
  const params = url.searchParams;
  params.set('client', client);
  params.set('job_id', jobId);
  params.set('msg_id', msgId);
  params.set('file_size', String(entry.fileSize));
  params.set('file_name', entry.name);
  params.set('file_suffix', entry.fileSuffix);
  params.set('file_type', entry.fileType);
  return url.toString();
}

/**
 * Normalise the gateway upload response to the shape expected in
 * `send_result.files` (official Hermes format).
 */
export function normalizeUploadResponse(payload, entry) {
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const objectKey = root?.objectKey ?? root?.object_key ?? root?.fileInfo?.objectKey;
  if (typeof objectKey !== 'string' || objectKey === '') {
    throw new LivisUploadError('Upload response is missing objectKey');
  }
  const fileInfo = root.fileInfo && typeof root.fileInfo === 'object' ? root.fileInfo : {};
  return {
    name: entry.name,
    fileSuffix: entry.fileSuffix,
    objectKey,
    fileSize: entry.fileSize,
    fileType: entry.fileType,
    file_path: deriveFilePath(objectKey),
    expiresAt: normalizeExpiry(root.expiresAt ?? root.expires_at ?? fileInfo.expiresAt),
  };
}

/**
 * Upload one validated file.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   httpUrl: string,
 *   client: string,
 *   jobId: string,
 *   accessToken: string,
 *   entry: Awaited<ReturnType<typeof validateUploadFile>>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} input
 */
export async function uploadOne(input) {
  const {
    fetchImpl,
    httpUrl,
    client,
    jobId,
    accessToken,
    entry,
    signal,
    timeoutMs = RELAY_POLICY.httpTimeoutMs,
  } = input;

  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new LivisUploadError('An access token is required to upload files');
  }

  const buffer = await fsp.readFile(entry.path);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: entry.fileType }), entry.fileName);

  const url = uploadUrl({ httpUrl, client, jobId, msgId: uuid(), entry });

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
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
      body: form,
      signal: effectiveSignal,
    });
  } catch (error) {
    throw new LivisUploadError('File upload request failed before receiving a response', {
      cause: error,
    });
  }

  const text = await response.text().catch(() => '');
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const error = new LivisUploadError(`File upload failed with HTTP ${response.status}`, {
      retryable: response.status === 429 || response.status >= 500,
    });
    error.status = response.status;
    throw error;
  }

  return normalizeUploadResponse(payload, entry);
}

/**
 * Validate + upload a list of files sequentially.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   httpUrl: string,
 *   client: string,
 *   jobId: string,
 *   accessToken: string,
 *   uploadRoot: string,
 *   files: string[],
 *   signal?: AbortSignal,
 * }} input
 */
export async function uploadFiles(input) {
  const { files, uploadRoot } = input;
  if (!Array.isArray(files) || files.length === 0) {
    throw new LivisUploadRejectedError('At least one file is required');
  }
  if (files.length > FILE_POLICY.maxFiles) {
    throw new LivisUploadRejectedError(
      `At most ${FILE_POLICY.maxFiles} files may be uploaded per job`,
    );
  }
  const entries = [];
  for (const filePath of files) {
    entries.push(await validateUploadFile(filePath, { uploadRoot }));
  }
  const results = [];
  for (const entry of entries) {
    results.push(await uploadOne({ ...input, entry }));
  }
  return results;
}
