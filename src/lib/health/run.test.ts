import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAllChecks } from './run'
import { diffHealth } from './diff'

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
