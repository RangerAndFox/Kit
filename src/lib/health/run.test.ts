import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAllChecks, readHeartbeatsWithRetry } from './run'
import { diffHealth } from './diff'
import { healthAlertText } from './alert-text'

function fixture() {
  let reads = 0
  const io = {
    runIntegrationProbes: async () => [],
    loadHeartbeats: async () => { reads++; return {} },
    getOrInitMonitorEpoch: async () => null,
    registerCronSchedules: async () => {},
    checkCronFreshness: () => [{ key: 'cron:worker', label: 'Worker', ok: false, detail: 'real failure' }],
  }
  return { io, reads: () => reads }
}
test('failed configuration write does not hide recorded worker failures', async () => {
  const f = fixture()
  f.io.registerCronSchedules = async () => { throw new Error('outage') }
  const results = await runAllChecks(f.io)
  assert.equal(f.reads(), 1)
  assert.equal(results.find(r => r.key === 'cron:worker')?.ok, false)
  assert.equal(results.find(r => r.key === 'cron:telemetry')?.ok, true)
  assert.equal(results.find(r => r.key === 'cron:configuration')?.ok, false)
})
test('heartbeat read failure reports unknown, not healthy or stale cached worker results', async () => {
  const f = fixture()
  f.io.loadHeartbeats = async () => { throw new Error('outage') }
  const results = await runAllChecks(f.io)
  assert.equal(results.find(r => r.key === 'cron:telemetry')?.ok, false)
  assert.equal(results.some(r => r.key === 'cron:worker'), false)
})
test('a subsequent good check explicitly recovers both monitoring keys', async () => {
  const results = await runAllChecks(fixture().io)
  const diff = diffHealth({ 'cron:telemetry': 'down', 'cron:configuration': 'down' }, results)
  assert.deepEqual(diff.recovered.map(r => r.key), ['cron:telemetry', 'cron:configuration'])
  assert.equal(results.find(r => r.key === 'cron:worker')?.ok, false)
})

test('a transient read retries once and evaluates actual job outcomes', async () => {
  const f = fixture(); let attempts = 0
  f.io.loadHeartbeats = async () => { if (++attempts === 1) throw new Error('timeout'); return {} }
  const results = await runAllChecks(f.io)
  assert.equal(attempts, 2)
  assert.equal(results.find(r => r.key === 'cron:telemetry')?.ok, true)
  assert.equal(results.find(r => r.key === 'cron:worker')?.ok, false)
})
test('repeated read failures do not loop or manufacture heartbeat data', async () => {
  let attempts = 0; let pauses = 0
  await assert.rejects(readHeartbeatsWithRetry(async () => { attempts++; throw new Error('timeout') },
    async () => { pauses++ }), /timeout/)
  assert.equal(attempts, 2); assert.equal(pauses, 1)
})
test('healthy read has no extra request or wait', async () => {
  let pauses = 0
  assert.equal(await readHeartbeatsWithRetry(async () => 'fresh', async () => { pauses++ }), 'fresh')
  assert.equal(pauses, 0)
})
test('monitor-only outage is not worded as a failed job; mixed failures stay visible', () => {
  const monitor = { key: 'cron:telemetry', label: 'Cron monitoring', ok: false }
  const text = healthAlertText({ downed: [monitor], recovered: [] })
  assert.match(text, /monitoring unavailable/); assert.doesNotMatch(text, /something went down/)
  const mixed = healthAlertText({ downed: [monitor, { key: 'worker', label: 'Worker', ok: false }], recovered: [] })
  assert.match(mixed, /something went down/); assert.match(mixed, /Worker/)
  assert.match(healthAlertText({ downed: [], recovered: [{ ...monitor, ok: true }] }), /recovered/)
})

test('schedule registration retries a timeout once without inventing job successes', async () => {
  const f = fixture(); let attempts = 0
  f.io.registerCronSchedules = async () => { if (++attempts === 1) throw new Error('TimeoutError') }
  const results = await runAllChecks(f.io)
  assert.equal(attempts, 2)
  assert.equal(results.find(r => r.key === 'cron:configuration')?.ok, true)
  assert.equal(results.find(r => r.key === 'cron:worker')?.ok, false)
})

test('two registration timeouts report unknown and preserve real worker failures', async () => {
  const f = fixture(); let attempts = 0
  f.io.registerCronSchedules = async () => { attempts++; throw new Error('TimeoutError') }
  const results = await runAllChecks(f.io)
  assert.equal(attempts, 2)
  assert.equal(results.find(r => r.key === 'cron:configuration')?.unknown, true)
  assert.equal(results.find(r => r.key === 'cron:worker')?.ok, false)
})

test('unknown Supabase status is warning-only; a later confirmed failure escalates', () => {
  const unknown = { key: 'supabase', label: 'Supabase', ok: false, unknown: true }
  const initial = diffHealth({}, [unknown])
  assert.doesNotMatch(healthAlertText(initial), /something went down|:red_circle:/)
  assert.match(healthAlertText(initial), /status is unknown/)
  assert.equal(diffHealth({ supabase: 'unknown' }, [unknown]).downed.length, 0)
  assert.equal(diffHealth({ supabase: 'unknown' }, [{ ...unknown, unknown: false }]).downed.length, 1)
  assert.equal(diffHealth({ supabase: 'unknown' }, [{ ...unknown, unknown: false, ok: true }]).recovered.length, 1)
})
