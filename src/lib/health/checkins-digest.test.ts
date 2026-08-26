import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parsedReconciliationStatus } from './checkins-digest'

describe('parsedReconciliationStatus', () => {
  const today = '2026-08-26'

  it('closes a zero-hour card without Harvest writes', () => {
    assert.equal(parsedReconciliationStatus({
      check_in_date: '2026-08-05',
      parsed_entries: [{ hours: 0, resolution: 'ambiguous' }],
      harvest_entry_ids: null,
    }, today), 'skipped')
  })

  it('expires a positive card outside the 14-day window', () => {
    assert.equal(parsedReconciliationStatus({
      check_in_date: '2026-08-04',
      parsed_entries: [{ hours: 8, resolution: 'matched', harvest_project_id: 1 }],
      harvest_entry_ids: null,
    }, today), 'expired')
  })

  it('keeps recent positive cards actionable', () => {
    assert.equal(parsedReconciliationStatus({
      check_in_date: '2026-08-13',
      parsed_entries: [{ hours: 8, resolution: 'matched', harvest_project_id: 1 }],
      harvest_entry_ids: null,
    }, today), null)
  })

  it('does not hide a zero-hour row that already carries a Harvest id', () => {
    assert.equal(parsedReconciliationStatus({
      check_in_date: '2026-07-13',
      parsed_entries: [{ hours: 0, resolution: 'matched', harvest_project_id: 1 }],
      harvest_entry_ids: [99],
    }, today), null)
  })
})
