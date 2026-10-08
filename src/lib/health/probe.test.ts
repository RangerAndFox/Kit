import { it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { runHealthProbe } from './probe'

it('returns real success and clears its deadline without a later abort', async () => {
  let signal: AbortSignal | undefined
  const result = await runHealthProbe('queue', 'Queue', async s => {
    signal = s
    return 'no dead-lettered events'
  }, 10)
  await delay(30)
  assert.equal(result.ok, true)
  assert.equal(result.detail, 'no dead-lettered events')
  assert.equal(signal?.aborted, false)
})

it('keeps a genuine unresolved queue failure visible without retrying it', async () => {
  let calls = 0
  const result = await runHealthProbe('queue', 'Queue', async () => {
    calls++
    throw new Error('upload requires manual review: provider timed out')
  })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.detail, 'upload requires manual review: provider timed out')
  assert.equal(result.unknown, undefined)
})

it('aborts a stalled read and reports unknown rather than a failed upload', async () => {
  let aborted = false
  const result = await runHealthProbe('queue', 'Queue', signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true
      reject(signal.reason)
    }, { once: true })
  }), 10)
  assert.equal(aborted, true)
  assert.equal(result.ok, false)
  assert.match(result.detail!, /current status unknown/)
})

it('still bounds providers that do not support cancellation', async () => {
  const result = await runHealthProbe('queue', 'Queue', () => new Promise(() => {}), 10)
  assert.equal(result.ok, false)
  assert.equal(result.unknown, true)
  assert.match(result.detail!, /two attempts/)
})

it('confirms a transient timeout with a fresh signal and real success', async () => {
  const signals: AbortSignal[] = []
  const result = await runHealthProbe('supabase', 'Supabase', async signal => {
    signals.push(signal)
    if (signals.length === 1) return new Promise(() => {})
    return 'fresh read'
  }, 5)
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  assert.equal(result.ok, true)
  assert.equal(result.unknown, undefined)
  assert.equal(result.detail, 'fresh read')
})

it('does not retry authorization errors or fabricate a success after two network failures', async () => {
  for (const [message, attempts, unknown] of [['401 unauthorized', 1, undefined], ['fetch failed', 2, true]] as const) {
    let calls = 0
    const result = await runHealthProbe('db', 'Database', async () => { calls++; throw new Error(message) }, 5)
    assert.equal(calls, attempts)
    assert.equal(result.ok, false)
    assert.equal(result.unknown, unknown)
  }
})
