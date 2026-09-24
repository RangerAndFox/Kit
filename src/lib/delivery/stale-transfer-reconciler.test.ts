/**
 * Stale-reconciler safety tests.
 * Run: npx tsx --test src/lib/delivery/stale-transfer-reconciler.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideStaleOutcome, isSkippable, reconcileStaleTransfers,
  type StaleTransferRow, type ProviderState, type ReconcilerClient,
} from './stale-transfer-reconciler'

const row = (over: Partial<StaleTransferRow> = {}): StaleTransferRow => ({
  id: 'a', project_id: 'p', state: 'processing', frameio_file_id: 'fio', dropbox_rev: 'r',
  created_at: '2026-09-01T00:00:00Z', retired_at: null, frameio_upload_enabled: true, ...over,
})
const provider = (over: Partial<ProviderState> = {}): ProviderState => ({
  exists: true, transcodeComplete: true, hasShare: true, sizeMatches: true, ...over,
})

describe('decideStaleOutcome', () => {
  it('leaves unresolved when provider state is unknown', () => {
    assert.equal(decideStaleOutcome(row(), null).outcome, 'leave_unresolved')
  })
  it('reconciles to ready only when fully verified complete', () => {
    assert.equal(decideStaleOutcome(row(), provider()).outcome, 'reconcile_ready')
  })
  it('marks failed only when the asset is verifiably absent', () => {
    assert.equal(decideStaleOutcome(row(), provider({ exists: false })).outcome, 'mark_failed')
  })
  it('leaves unresolved on partial/ambiguous provider state', () => {
    assert.equal(decideStaleOutcome(row(), provider({ transcodeComplete: false })).outcome, 'leave_unresolved')
    assert.equal(decideStaleOutcome(row(), provider({ hasShare: false })).outcome, 'leave_unresolved')
    assert.equal(decideStaleOutcome(row(), provider({ sizeMatches: false })).outcome, 'leave_unresolved')
  })
})

describe('isSkippable', () => {
  it('skips retired, upload-disabled, and non-processing rows', () => {
    assert.equal(isSkippable(row({ retired_at: '2026-09-01T00:00:00Z' })).skip, true)
    assert.equal(isSkippable(row({ frameio_upload_enabled: false })).skip, true)
    assert.equal(isSkippable(row({ state: 'ready' })).skip, true)
    assert.equal(isSkippable(row()).skip, false)
  })
})

class FakeClient implements ReconcilerClient {
  stateWrites: Array<{ id: string; state: string }> = []
  constructor(private rows: StaleTransferRow[]) {}
  async loadStaleProcessing() { return this.rows }
  async setTransferState(id: string, state: 'ready' | 'failed') { this.stateWrites.push({ id, state }) }
}

describe('reconcileStaleTransfers', () => {
  it('is a no-op when disabled', async () => {
    const c = new FakeClient([row()])
    let verified = 0
    const res = await reconcileStaleTransfers(c, { verifyProvider: async () => { verified++; return provider() }, env: {} })
    assert.equal(res.enabled, false)
    assert.equal(verified, 0)
    assert.equal(c.stateWrites.length, 0)
  })

  it('never calls the provider for skipped (retired / upload-disabled) rows', async () => {
    const c = new FakeClient([
      row({ id: 'retired', retired_at: '2026-09-01T00:00:00Z' }),
      row({ id: 'disabled', frameio_upload_enabled: false }),
    ])
    const seen: string[] = []
    await reconcileStaleTransfers(c, {
      verifyProvider: async (r) => { seen.push(r.id); return provider() },
      env: { STALE_TRANSFER_RECONCILER_ENABLED: 'true' }, dryRun: false,
    })
    assert.deepEqual(seen, [])            // provider never consulted for skipped rows
    assert.equal(c.stateWrites.length, 0) // nothing written
  })

  it('dry-run yields decisions but writes nothing', async () => {
    const c = new FakeClient([row()])
    const res = await reconcileStaleTransfers(c, {
      verifyProvider: async () => provider(),
      env: { STALE_TRANSFER_RECONCILER_ENABLED: 'true' }, // dryRun defaults true
    })
    assert.equal(res.decisions[0].outcome, 'reconcile_ready')
    assert.equal(res.applied, 0)
    assert.equal(c.stateWrites.length, 0)
  })

  it('when executed, applies only ledger-state corrections (never for unresolved)', async () => {
    const c = new FakeClient([
      row({ id: 'complete' }),
      row({ id: 'gone' }),
      row({ id: 'ambiguous' }),
    ])
    const states: Record<string, ProviderState> = {
      complete: provider(), gone: provider({ exists: false }), ambiguous: provider({ transcodeComplete: false }),
    }
    await reconcileStaleTransfers(c, {
      verifyProvider: async (r) => states[r.id],
      env: { STALE_TRANSFER_RECONCILER_ENABLED: 'true' }, dryRun: false,
    })
    assert.deepEqual(c.stateWrites, [
      { id: 'complete', state: 'ready' },
      { id: 'gone', state: 'failed' },
      // 'ambiguous' left unresolved → no write
    ])
  })
})
