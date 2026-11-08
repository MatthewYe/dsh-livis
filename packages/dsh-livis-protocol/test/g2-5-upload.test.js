import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeHub } from '../src/testing/fake-hub.js';
import { createLivisClient } from '../src/client.js';
import { createSilentLogger } from '../src/redact.js';

const MARKDOWN = '# Evidence\n\nFake upload for G2-5.\n';

test('G2-5: upload sends multipart fields, Bearer auth, and normalises the response', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'livis-upload-test-'));
  const uploadRoot = join(stateDir, 'uploads');
  await mkdir(uploadRoot, { recursive: true });
  const filePath = join(uploadRoot, 'note.md');
  await writeFile(filePath, MARKDOWN, 'utf8');

  const objectKey = 'livis-bucket/files/2026/11/job-upload-1/note.md';
  const hub = await createFakeHub({
    uploadResponse: {
      objectKey,
      fileInfo: { objectKey, fileSize: Buffer.byteLength(MARKDOWN), fileType: 'text/markdown' },
      expiresAt: '2026-11-08T02:00:00.000Z',
    },
  });
  const client = createLivisClient({
    stateDir,
    uploadRoot,
    websocketUrl: hub.urls.ws,
    httpUrl: hub.urls.http,
    idaasEndpoint: hub.urls.idaas,
    refreshToken: 'FAKE_REFRESH_TOKEN_BOOTSTRAP',
    logger: createSilentLogger(),
  });

  t.after(async () => {
    await client.stop();
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const uploaded = await client.uploadFile(filePath, { jobId: 'job-upload-1' });
  assert.deepEqual(uploaded, {
    name: 'note',
    fileSuffix: 'md',
    objectKey,
    fileSize: Buffer.byteLength(MARKDOWN),
    fileType: 'text/markdown',
    file_path: '/files/2026/11/job-upload-1',
    expiresAt: '2026-11-08T02:00:00.000Z',
  });

  assert.equal(hub.uploads.length, 1);
  const record = hub.uploads[0];
  assert.equal(record.query.client, 'hermes');
  assert.equal(record.query.job_id, 'job-upload-1');
  assert.match(record.query.msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(record.query.file_size, String(Buffer.byteLength(MARKDOWN)));
  assert.equal(record.query.file_name, 'note');
  assert.equal(record.query.file_suffix, 'md');
  assert.equal(record.query.file_type, 'text/markdown');

  assert.equal(record.authorizationPresent, true);
  assert.equal(record.bearerToken, hub.lastIssuedAccessToken());
  assert.match(record.contentType, /^multipart\/form-data; boundary=/);

  const fileField = record.fields.find((field) => field.name === 'file');
  assert.ok(fileField, 'multipart must include a "file" field');
  assert.equal(fileField.fileName, 'note.md');
  assert.equal(fileField.contentType, 'text/markdown');
  assert.equal(fileField.size, Buffer.byteLength(MARKDOWN));
  assert.equal(fileField.sha256, createHash('sha256').update(MARKDOWN).digest('hex'));

  // Whitelist: executable files are refused before any request is made.
  const exePath = join(uploadRoot, 'run.exe');
  await writeFile(exePath, 'MZ');
  const uploadsBefore = hub.uploads.length;
  await assert.rejects(client.uploadFile(exePath, { jobId: 'job-upload-1' }), (error) => {
    assert.equal(error.code, 'LIVIS_UPLOAD_REJECTED');
    return true;
  });
  assert.equal(hub.uploads.length, uploadsBefore);

  // Path containment: files outside uploadRoot are refused.
  const outside = join(stateDir, 'outside.md');
  await writeFile(outside, 'outside');
  await assert.rejects(client.uploadFile(outside, { jobId: 'job-upload-1' }), (error) => {
    assert.equal(error.code, 'LIVIS_UPLOAD_REJECTED');
    return true;
  });
  assert.equal(hub.uploads.length, uploadsBefore);
});
