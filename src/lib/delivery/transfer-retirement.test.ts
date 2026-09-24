/**
 * Retirement decision + IO-guard tests.
 * Run: npx tsx --test src/lib/delivery/transfer-retirement.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyForRetirement, retireTransfers,
  type TransferRow, type RetirementClient,
} from './transfer-retirement'

const row = (id: string, state: string, retired_at: string | null = null): TransferRow => ({
  id, project_id: 'p', state, dropbox_file_id: `f-${id}`, dropbox_rev: 'r', retired_at,
})

describe('classifyForRetirement', () => {
  it('refuses delivered rows, no-ops retired rows, retires processing/failed', () => {
    const plan = classifyForRetirement([
      row('a', 'processing'), row('b', 'failed'),
      row('c', 'ready'), row('d', 'processing', '2026-09-01T00:00:00Z'),
    ])
    assert.deepEqual(plan.eligible.map((d) => d.id), ['a', 'b'])
    assert.deepEqual(plan.refused.map((d) => d.id), ['c'])
    assert.deepEqual(plan.alreadyRetired.map((d) => d.id), ['d'])
  })
})

class FakeClient implements RetirementClient {
  audits: string[] = []
  retired: string[] = []
  inboxRetired: string[] = []
  constructor(private rows: TransferRow[]) {}
  async loadTransfers(ids: string[]) { return this.rows.filter((r) => ids.includes(r.id)) }
  async markTransferRetired(id: string) { this.retired.push(id) }
  async insertAudit(e: { transfer_id: string }) { this.audits.push(e.transfer_id) }
  async retireInboxEventsForFile(_p: string | null, f: string | null) { this.inboxRetired.push(f!); return 2 }
}

describe('retireTransfers', () => {
  it('dry-run writes nothing but returns the plan', async () => {
    const c = new FakeClient([row('a', 'processing'), row('c', 'ready')])
    const res = await retireTransfers(c, { transferIds: ['a', 'c'], reason: 'fabric', retiredBy: 'op' })
    assert.equal(res.dryRun, true)
    assert.equal(res.retiredTransferIds.length, 0)
    assert.deepEqual([c.audits, c.retired, c.inboxRetired], [[], [], []])
    assert.deepEqual(res.plan.eligible.map((d) => d.id), ['a'])
  })

  it('executes only eligible rows, audits each, and never touches a delivered row', async () => {
    const c = new FakeClient([row('a', 'processing'), row('c', 'ready'), row('d', 'failed', '2026-09-01T00:00:00Z')])
    const res = await retireTransfers(c, {
      transferIds: ['a', 'c', 'd'], reason: 'fabric', retiredBy: 'op', dryRun: false,
    })
    assert.deepEqual(res.retiredTransferIds, ['a'])
    assert.deepEqual(c.audits, ['a'])       // audit written for eligible only
    assert.deepEqual(c.retired, ['a'])      // 'c' (ready) and 'd' (retired) untouched
    assert.equal(res.retiredInboxEvents, 2) // inbox events retired for 'a'
  })

  it('is idempotent — an already-retired row does no writes', async () => {
    const c = new FakeClient([row('a', 'processing', '2026-09-01T00:00:00Z')])
    const res = await retireTransfers(c, { transferIds: ['a'], reason: 'x', retiredBy: 'op', dryRun: false })
    assert.deepEqual([c.audits, c.retired], [[], []])
    assert.deepEqual(res.plan.alreadyRetired.map((d) => d.id), ['a'])
  })
})
