import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueKey, memeSchema, newMeme, nextMidnight, publicSafeText, validMonthDay } from './model'
import { deliverCulture } from './delivery'
import { handleCulture, type CultureHttpPorts } from './http'
import { sendCultureMessage } from './slack-send'
import { cultureRpcRow } from './rpc'

const fixture = () => ({ ...newMeme('custom', 'C12345678', 'America/New_York', '11111111-1111-4111-8111-111111111111'), name: 'Studio wins', fire_date: '2026-09-14' })
test('single-row RPC responses support PostgREST arrays and singular objects without accepting ambiguity', () => {
  assert.deepEqual(cultureRpcRow([fixture()]), fixture())
  assert.deepEqual(cultureRpcRow(fixture()), fixture())
  for (const value of [null, [], [null], { id: null, name: null }, [{ id: null, name: null }]]) assert.equal(cultureRpcRow(value), null)
  for (const value of [[fixture(), fixture()], {}, { id: 'invalid' }, true, undefined]) assert.throws(() => cultureRpcRow(value))
})
test('calendar validation rejects impossible dates and protects birthdays without a birth year', () => {
  assert.equal(validMonthDay('02-29'), true)
  for (const value of ['04-31', '02-30', '13-01', '1-2']) assert.equal(validMonthDay(value), false)
  assert.equal(memeSchema.safeParse(fixture()).success, true)
  assert.equal(memeSchema.safeParse({ ...fixture(), fire_date: '2026-02-29' }).success, false)
})
test('drafts, paused rules, wrong dates and late events do not post', () => {
  const now = new Date('2026-09-14T13:02:00Z')
  assert.equal(dueKey(fixture(), now, () => false), null)
  const item = { ...fixture(), status: 'enabled' as const }
  assert.equal(dueKey(item, now, () => false), '2026-09-14')
  for (const time of ['2026-09-14T12:59Z', '2026-09-14T13:05Z', '2026-09-15T13:00Z']) assert.equal(dueKey(item, new Date(time), () => false), null)
  assert.equal(dueKey({ ...item, status: 'paused' }, now, () => false), null)
})
test('DST repeats have one occurrence key; setup uses the next local midnight', () => {
  const item = { ...fixture(), status: 'enabled' as const, fire_date: '2026-11-01', local_time: '01:30' }
  assert.equal(dueKey(item, new Date('2026-11-01T05:30Z'), () => false), '2026-11-01')
  assert.equal(dueKey(item, new Date('2026-11-01T06:30Z'), () => false), '2026-11-01')
  assert.equal(nextMidnight(new Date('2026-11-01T05:30Z'), item.timezone), '2026-11-02T05:00:00.000Z')
})
test('financial details, contacts, links and Slack mass mentions fail validation', () => {
  for (const value of ['$5000', 'client@example.com', 'budget is great', 'https://example.com', '<!channel>', 'Call 212-555-1212']) {
    assert.equal(publicSafeText(value), false)
    assert.equal(memeSchema.safeParse({ ...fixture(), briefing: value }).success, false)
  }
  assert.equal(publicSafeText('Celebrate teamwork and tiny wins'), true)
  assert.equal(memeSchema.safeParse({ ...fixture(), workspace_id: 'untrusted' }).success, false)
})
test('posting ledger distinguishes preparation failures, uncertain sends and confirmed sends', async () => {
  for (const scenario of ['success', 'prepare', 'slack', 'missing-ts', 'fenced'] as const) {
    const statuses: string[] = []
    let sends = 0
    const result = await deliverCulture({
      beginSend: async () => scenario !== 'fenced',
      prepareAndPost: async beforeSend => {
        if (scenario === 'prepare') throw new Error('provider unavailable')
        await beforeSend(); sends++
        if (scenario === 'slack') throw new Error('timeout')
        return { posted: true, ts: scenario === 'missing-ts' ? undefined : '123.456' }
      },
      finish: async status => { statuses.push(status) },
    })
    assert.equal(result, scenario === 'success')
    assert.deepEqual(statuses, [scenario === 'success' ? 'posted' : ['prepare', 'fenced'].includes(scenario) ? 'failed' : 'review'])
    assert.equal(sends, ['prepare', 'fenced'].includes(scenario) ? 0 : 1)
  }
})
test('acknowledgement persistence failure becomes review, never a second Slack send', async () => {
  let sends = 0; const statuses: string[] = []
  assert.equal(await deliverCulture({ beginSend: async () => true,
    prepareAndPost: async before => { await before(); sends++; return { posted: true, ts: '123' } },
    finish: async status => { statuses.push(status); if (status === 'posted') throw new Error('database outage') },
  }), false)
  assert.equal(sends, 1); assert.deepEqual(statuses, ['posted', 'review'])
})
function ports(allowed = true) {
  const calls: unknown[][] = []
  const result: CultureHttpPorts = { access: async () => allowed ? { workspaceId: 'verified-workspace', userId: 'verified-admin' } : null,
    load: async () => { throw new Error('not used') }, initialize: async (...args) => { calls.push(args) }, save: async (...args) => { calls.push(args) } }
  return { calls, result }
}
const request = (body: unknown, origin = 'https://kit.test') => new Request('https://kit.test/api/culture-center', { method: 'POST', headers: { origin }, body: typeof body === 'string' ? body : JSON.stringify(body) })
test('HTTP denies untrusted origins, artists and malformed bodies before any mutation', async () => {
  const denied = ports(false)
  assert.equal((await handleCulture(request('not json'), denied.result)).status, 403)
  const admin = ports()
  assert.equal((await handleCulture(request({}, 'https://evil.test'), admin.result)).status, 403)
  assert.equal((await handleCulture(request('x'.repeat(12001)), admin.result)).status, 413)
  assert.equal((await handleCulture(request('not json'), admin.result)).status, 400)
  assert.equal((await handleCulture(request({ action: 'save', item: fixture(), confirmed: false, workspaceId: 'other' }), admin.result)).status, 400)
  assert.equal(admin.calls.length + denied.calls.length, 0)
})
test('HTTP saves only in the authorized workspace with the verified actor', async () => {
  const admin = ports()
  assert.equal((await handleCulture(request({ action: 'save', item: fixture(), confirmed: false }), admin.result)).status, 200)
  assert.deepEqual(admin.calls[0], ['verified-workspace', 'verified-admin', fixture(), false])
})
test('managed Slack sends never retry an ambiguous transport failure', async () => {
  const originalFetch = globalThis.fetch, originalToken = process.env.SLACK_BOT_TOKEN
  let attempts = 0
  process.env.SLACK_BOT_TOKEN = 'synthetic-test-token'
  globalThis.fetch = async () => { attempts++; throw new Error('timeout after request') }
  try { await assert.rejects(sendCultureMessage({channel:'C12345678',text:'Studio wins'})); assert.equal(attempts,1) }
  finally { globalThis.fetch = originalFetch; if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = originalToken }
})
