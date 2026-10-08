import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { publishHealthReport, planHealthReport, type HealthReport, type HealthReportStore, type PendingReport } from './reporting'
import { resolveHealthDm } from './report-store'
import { checkStatus, type CheckResult } from './diff'
import { summarizeCheckins, formatHealthDigest } from './digest'
import type { HealthRow } from './state'

const day = '2026-10-08'
const summary = summarizeCheckins([], day)
const result = (ok: boolean, unknown = false): CheckResult => ({ key: 'supabase', label: 'Supabase', ok, unknown })
function report(id: string, minute: number, check: CheckResult, digest = false): HealthReport {
  return { id, observed_at: `${day}T13:${String(minute).padStart(2, '0')}:00Z`, recipient: 'UOWNER', checks: [check],
    ...(digest ? { digest: { summary, dateLabel: 'Thu, Oct 8' } } : {}) }
}
function fixture() {
  const queue = new Map<string, PendingReport>()
  const state = new Map<string, HealthRow>()
  const messages = new Map<string, string>() // fake existing durable Slack receipt owner
  let commitFails = false; let sendFails = false
  const store: HealthReportStore = {
    async enqueue(r) { if (!queue.has(r.id)) queue.set(r.id, { ...r, plan: null }) },
    async pending() { return [...queue.values()].slice(0, 20) },
    async state() { return [...state.values()] },
    async plan(id, plan) { const row = queue.get(id)!; row.plan ??= plan; return row.plan },
    async complete(id) {
      if (commitFails) throw new Error('commit failed')
      const row = queue.get(id)!
      for (const check of row.plan!.checks) state.set(check.key, {
        key: check.key, status: checkStatus(check), detail: check.detail ?? null,
        since: row.observed_at, checked_at: row.observed_at,
      })
      queue.delete(id)
    },
  }
  const io = { store, resolveDm: async () => 'DOWNER', send: async (input: { key: string; text: string }) => {
    if (sendFails) throw new Error('send failed')
    messages.set(input.key, messages.get(input.key) ?? input.text)
  } }
  return { io, state, queue, messages, failCommit(value: boolean) { commitFails = value }, failSend(value: boolean) { sendFails = value } }
}

test('digest failure becomes shared history; watchdog sends one recovery, then stays silent', async () => {
  const f = fixture()
  await publishHealthReport(report('digest', 0, result(false, true), true), f.io)
  assert.equal(f.state.get('supabase')?.status, 'unknown')
  await publishHealthReport(report('watchdog', 10, result(true)), f.io)
  await publishHealthReport(report('watchdog-next', 20, result(true)), f.io)
  assert.equal(f.messages.size, 2)
  assert.match(f.messages.get('health-report:watchdog')!, /Supabase.*recovered/)
})

test('watchdog and digest observing same failure do not duplicate a transition alert', async () => {
  const f = fixture()
  await publishHealthReport(report('digest', 0, result(false), true), f.io)
  await publishHealthReport(report('watchdog', 10, result(false)), f.io)
  assert.equal(f.messages.size, 1)
})

test('failed send cannot advance state or consume a recovery', async () => {
  const f = fixture(); f.failSend(true)
  await assert.rejects(publishHealthReport(report('digest', 0, result(false), true), f.io), /send failed/)
  assert.equal(f.state.size, 0)
  assert.equal(f.queue.size, 1)
  f.failSend(false)
  await publishHealthReport(report('watchdog', 10, result(true)), f.io)
  assert.equal(f.messages.size, 2)
  assert.equal(f.state.get('supabase')?.status, 'up')
})

test('crash after Slack acknowledgment reuses immutable plan and receipt before processing recovery', async () => {
  const f = fixture(); f.failCommit(true)
  await assert.rejects(publishHealthReport(report('digest', 0, result(false), true), f.io), /commit failed/)
  assert.equal(f.messages.size, 1)
  assert.equal(f.state.size, 0)
  const plan = f.queue.get('digest')!.plan
  f.failCommit(false)
  await publishHealthReport(report('watchdog', 10, result(true)), f.io)
  assert.equal(f.messages.size, 2)
  assert.match(plan!.text!, /issue/)
  assert.match(f.messages.get('health-report:watchdog')!, /recovered/)
})

test('slow older run cannot reopen incident; delayed digest uses newer status', async () => {
  const f = fixture()
  await publishHealthReport(report('new', 20, result(true)), f.io)
  await publishHealthReport(report('old', 0, result(false)), f.io)
  assert.equal(f.messages.size, 0)
  const plan = planHealthReport(report('old-digest', 10, result(false), true), [...f.state.values()])
  assert.equal(plan.checks.length, 0)
  assert.match(plan.text!, /all systems go/)
})

test('digest can close incident and explicitly report recovery', async () => {
  const f = fixture()
  await publishHealthReport(report('watchdog', 0, result(false, true)), f.io)
  await publishHealthReport(report('digest', 10, result(true), true), f.io)
  assert.match(f.messages.get('health-report:digest')!, /Supabase.*recovered/)
})

test('unknown telemetry never renders fresh cron count or confirmed downtime', () => {
  const text = formatHealthDigest([result(false, true), { key: 'cron:telemetry', label: 'Cron monitoring', ok: false, unknown: true }], summary, day)
  assert.match(text, /outcomes unknown/)
  assert.doesNotMatch(text, /fresh|:red_circle:|:rotating_light:/)
  const healthy = formatHealthDigest([{ key: 'cron:telemetry', label: 'Monitor', ok: true }, { key: 'cron:worker', label: 'Worker', ok: true }], summary, day)
  assert.match(healthy, /1\/1 fresh/)
})

test('private recipient resolution refuses public channels and uses real DM ids for receipts', async () => {
  assert.equal(await resolveHealthDm('DOWNER'), 'DOWNER')
  assert.equal(await resolveHealthDm('UOWNER', async () => ({ ok: true, channel: { id: 'DOWNER' } })), 'DOWNER')
  await assert.rejects(resolveHealthDm('CCHANNEL'), /private Kit DM/)
  await assert.rejects(resolveHealthDm('UOWNER', async () => ({ ok: false })), /could not be opened/)
})

test('both reporters serialize the entire publication step with the same environment concurrency key', () => {
  for (const name of ['health-cron', 'health-digest']) {
    const source = readFileSync(new URL(`../inngest/${name}.ts`, import.meta.url), 'utf8')
    assert.match(source, /concurrency: \{ limit: 1, key: "'kit-health-reporting'", scope: 'env' \}/)
    assert.match(source, /step.run\('publish-health-report'/)
    assert.doesNotMatch(source, /saveHealthState|postSlackAsKit/)
  }
})
