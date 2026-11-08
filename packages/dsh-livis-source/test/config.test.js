/**
 * Unit tests for the P1 plugin skeleton: source configuration validation and
 * registration wiring. Run with `node --test` (or `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  Config, LivisConfigSchema, apply, inject, livisKind, name,
} from '../index.js'

test('plugin metadata is stable', () => {
  assert.equal(name, 'dsh-livis-source')
  assert.deepEqual(inject, ['orchestrator'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
  assert.deepEqual(Config['~standard'].validate({}), { value: {} })
  assert.equal(livisKind.kind, 'livis')
  assert.deepEqual(livisKind.health, ['livis'])
})

test('source config accepts a valid value and fills defaults', () => {
  const parsed = LivisConfigSchema.parse({
    enabled: false,
    stateDir: '/tmp/dsh-livis-source-test',
    fallbackText: 'fallback',
    pendingTimeoutMs: 5000,
    allowedActor: 'user-node-1',
  })
  assert.deepEqual(parsed, {
    enabled: false,
    stateDir: '/tmp/dsh-livis-source-test',
    fallbackText: 'fallback',
    pendingTimeoutMs: 5000,
    allowedActor: 'user-node-1',
  })

  const defaults = LivisConfigSchema.parse({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.pendingTimeoutMs, 60000)
  assert.equal(defaults.allowedActor, '')
  assert.ok(defaults.stateDir.endsWith('livis-source'))
})

test('source config rejects invalid values', () => {
  assert.equal(LivisConfigSchema.safeParse({ pendingTimeoutMs: 999 }).success, false)
  assert.equal(LivisConfigSchema.safeParse({ pendingTimeoutMs: 'soon' }).success, false)
  assert.equal(LivisConfigSchema.safeParse({ enabled: 'yes' }).success, false)
  assert.equal(LivisConfigSchema.safeParse({ stateDir: '   ' }).success, false)
  assert.equal(LivisConfigSchema.safeParse({ unknownKey: true }).success, false)
})

test('policy config rejects duplicate actors', () => {
  assert.equal(livisKind.policy.schema.safeParse({ allowed: [{ id: 'a' }, { id: 'a' }] }).success, false)
  assert.equal(livisKind.policy.schema.safeParse({ allowed: [{ id: 'a' }, { id: 'b' }] }).success, true)
})

test('apply registers the kind exactly once and reports paused when disabled', async () => {
  const registered = []
  const reports = []
  const source = {
    ready: Promise.resolve(),
    config: () => LivisConfigSchema.parse({ enabled: false }),
    report: (entry, health) => reports.push({ entry, health }),
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { return fn() },
    orchestrator: {
      sources: {
        register(kind) {
          registered.push(kind)
          return () => {}
        },
      },
      context: () => source,
    },
  }

  apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(registered.length, 1)
  assert.equal(registered[0], livisKind)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].entry, 'livis')
  assert.equal(reports[0].health.state, 'paused')
})
