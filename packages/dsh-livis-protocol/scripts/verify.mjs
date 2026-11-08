#!/usr/bin/env node
/**
 * Run the six P2 gate test files, then write secret-free evidence JSON to the
 * superagent workspace.
 *
 *   node scripts/verify.mjs [--out <dir>]
 *
 * Each evidence file follows the PLAN schema:
 *   { id, gate, assertion, command, cwd, startedAt, finishedAt, durationMs,
 *     exitCode, result, stdoutSha256, stdout, stderr, pass, fail, repoClean }
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Evidence is written into the sibling dsh-superagent checkout's git-ignored
// .artifacts/ directory. SUPERAGENT_ROOT overrides the default so the script
// works from any checkout layout.
const SUPERAGENT_ROOT = process.env.SUPERAGENT_ROOT
  || resolve(fileURLToPath(new URL('../../../../dsh-superagent-prototype', import.meta.url)));
const DEFAULT_OUT = join(SUPERAGENT_ROOT, '.artifacts', 'verify', 'p2');

const GATES = [
  {
    id: 'V2-1',
    gate: 'G2-1',
    testFile: 'test/g2-1-handshake.test.js',
    assertion:
      'Connect URL carries ?protocol_version=1; connect metadata/payload fields match Hermes v0.1.9 (client=hermes, agent_id=hermes-<uuid>, device_id=pc_<uuid>, nodeType personl-device where required); heartbeat frames recur every heartbeatMs with the common envelope; health transitions connect -> handshaking -> connected.',
  },
  {
    id: 'V2-2',
    gate: 'G2-2',
    testFile: 'test/g2-2-inbox.test.js',
    assertion:
      'Inbound payload.data parses as both a JSON string and an object; content is trimmed; every valid send_message is acked with ack_send_message; cancel_chat is acked with ack_cancel_chat and emits one cancel; malformed frames increment invalidFrames without crashing, reconnecting, or being acked; a later valid frame is still delivered and duplicate deliveries of canceled jobs are acked but not re-executed.',
  },
  {
    id: 'V2-3',
    gate: 'G2-3',
    testFile: 'test/g2-3-result.test.js',
    assertion:
      'send_result payload.data is the nested compact JSON string {"text","files"}; ack_send_result ref_msg_id resolves the wait; a lost ack retries exactly maxResultAttempts (4) times with distinct msg_ids and identical payload, then throws LIVIS_RESULT_NOT_ACKED and caches for replay; duplicate job delivery is acked and replays the cached bytes once, without a second trigger or second result; a second sendResult for a completed job is dropped.',
  },
  {
    id: 'V2-4',
    gate: 'G2-4',
    testFile: 'test/g2-4-device-auth.test.js',
    assertion:
      'Device flow posts /aux with client_id/audience/scope super offline_access/offline_access=true; polling treats HTTP 428 and 400 authorization_pending as pending, 400 slow_down adds 5s; success requires access+refresh; refresh rotates and persists the refresh token; 401 invalid_grant clears tokens and requires a new device login; revoke posts the refresh token and clears local state regardless; state.json is 0600 and stateDir 0700 with no access token persisted.',
  },
  {
    id: 'V2-5',
    gate: 'G2-5',
    testFile: 'test/g2-5-upload.test.js',
    assertion:
      'Upload posts to /api/v1/files/upload with client=hermes, job_id, msg_id, file_size, file_name stem, lower-case file_suffix, file_type; Authorization Bearer uses the IdaaS access token; multipart field "file" has the full filename and MIME type with identical bytes; response is normalised to objectKey/file_path/expiresAt; non-whitelisted and outside-root files are rejected before any request.',
  },
  {
    id: 'V2-6',
    gate: 'G2-6',
    testFile: 'test/g2-6-health-redaction.test.js',
    assertion:
      'Two token_expiring frames cause exactly one token_refresh (single-flight) with the rotated tokens and no reconnect; logs, errors and health() contain no raw access/refresh/Bearer values; health phases traverse stopped -> connected -> reconnecting -> connected; identity is stable across reconnect; after stop() no further frames are sent and no timers keep firing.',
  },
];

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      args.out = resolve(argv[i + 1] ?? '');
      i += 1;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/verify.mjs [--out <evidence-dir>]');
      process.exit(0);
    }
  }
  return args;
}

function redact(text) {
  return String(text)
    .replace(/FAKE_(?:ACCESS|REFRESH)_TOKEN[A-Z0-9_]*/g, '[REDACTED_TOKEN]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(
      /("(?:access_token|refresh_token|device_code|token)"\s*:\s*")([^"]+)(")/g,
      '$1[REDACTED]$3',
    );
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function run(command, args, { cwd }) {
  return new Promise((resolvePromise) => {
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += `\nspawn error: ${error.message}\n`;
    });
    child.on('close', (code, signal) => {
      const finishedAt = new Date();
      resolvePromise({
        command,
        args,
        startedAt,
        finishedAt,
        durationMs: Number((process.hrtime.bigint() - startedNs) / 1_000_000n),
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function tapCounts(stdout) {
  const pass = Number(stdout.match(/^# pass (\d+)$/m)?.[1] ?? NaN);
  const fail = Number(stdout.match(/^# fail (\d+)$/m)?.[1] ?? NaN);
  return {
    pass: Number.isNaN(pass) ? null : pass,
    fail: Number.isNaN(fail) ? null : fail,
  };
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(temp, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const nodeVersion = process.version;
  const platform = `${process.platform}-${process.arch}`;
  const evidence = [];
  let failures = 0;

  console.log(`P2 protocol gate verification`);
  console.log(`  library: ${LIB_ROOT}`);
  console.log(`  evidence: ${args.out}`);
  console.log(`  node: ${nodeVersion} (${platform})`);
  console.log('');

  for (const gate of GATES) {
    const testPath = join(LIB_ROOT, gate.testFile);
    const argsForNode = ['--test', '--test-reporter=tap', testPath];
    const result = await run(process.execPath, argsForNode, { cwd: LIB_ROOT });
    const counts = tapCounts(result.stdout);
    const resultValue = result.exitCode === 0 ? 'pass' : 'fail';
    if (resultValue === 'fail') failures += 1;

    const record = {
      id: gate.id,
      gate: gate.gate,
      assertion: gate.assertion,
      result: resultValue,
      command: `${process.execPath} --test --test-reporter=tap ${gate.testFile}`,
      cwd: LIB_ROOT,
      testFile: testPath,
      startedAt: result.startedAt.toISOString(),
      finishedAt: result.finishedAt.toISOString(),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      stdoutSha256: sha256(result.stdout),
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
      pass: counts.pass,
      fail: counts.fail,
      environment: {
        nodeVersion,
        platform,
        libraryRoot: LIB_ROOT,
      },
      repoClean: null,
      repoPorcelain: null,
    };
    evidence.push(record);

    const outPath = join(args.out, `${gate.id}.json`);
    await writeJsonAtomic(outPath, record);
    console.log(
      `${gate.id} ${gate.gate} ${resultValue.toUpperCase()} ` +
        `(${counts.pass ?? '?'} pass, ${counts.fail ?? '?'} fail, ${result.durationMs}ms) -> ${outPath}`,
    );
  }

  // The superagent repo must stay byte-for-byte clean (evidence lives under a
  // git-ignored .artifacts/ directory).
  const repo = await run('git', ['status', '--porcelain'], { cwd: SUPERAGENT_ROOT });
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: SUPERAGENT_ROOT });
  const porcelain = repo.stdout.trim();
  const repoClean = repo.exitCode === 0 && porcelain === '';

  // Redaction self-check: none of the emitted evidence may contain token-looking
  // material. This runs after every file is written to catch a regression.
  const joined = evidence.map((record) => `${record.stdout}\n${record.stderr}`).join('\n');
  const leakPatterns = [
    /FAKE_(?:ACCESS|REFRESH)_TOKEN/,
    /Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{16,}/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ];
  const redactionClean = leakPatterns.every((pattern) => !pattern.test(joined));

  for (const record of evidence) {
    record.repoClean = repoClean;
    record.repoPorcelain = porcelain;
    record.repoHead = head.stdout.trim() || null;
    record.redactionClean = redactionClean;
  }
  // Rewrite with the repository facts included.
  for (const record of evidence) {
    await writeJsonAtomic(join(args.out, `${record.id}.json`), record);
  }

  const summary = {
    protocol: 'p2',
    generatedAt: new Date().toISOString(),
    libraryRoot: LIB_ROOT,
    evidenceDir: args.out,
    nodeVersion,
    platform,
    gates: evidence.map((record) => ({
      id: record.id,
      gate: record.gate,
      result: record.result,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      pass: record.pass,
      fail: record.fail,
      stdoutSha256: record.stdoutSha256,
    })),
    passed: evidence.filter((record) => record.result === 'pass').length,
    failed: failures,
    repo: {
      path: SUPERAGENT_ROOT,
      head: head.stdout.trim() || null,
      clean: repoClean,
      porcelain,
    },
    redactionClean,
  };
  await writeJsonAtomic(join(args.out, 'summary.json'), summary);

  console.log('');
  console.log(`repo clean: ${repoClean}${porcelain ? ` (porcelain: ${porcelain})` : ''}`);
  console.log(`redaction clean: ${redactionClean}`);
  console.log(`gates passed: ${summary.passed}/${evidence.length}`);

  if (failures > 0 || !repoClean || !redactionClean) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('verify.mjs failed:', error);
  process.exitCode = 1;
});
