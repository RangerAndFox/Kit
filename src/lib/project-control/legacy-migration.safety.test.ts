import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyDuplicateDeletionAuthorized } from './legacy-migration'

describe('legacy project migration destructive guard', () => {
  it('fails closed unless both independent confirmations are exact', () => {
    assert.equal(legacyDuplicateDeletionAuthorized({}), false)
    assert.equal(legacyDuplicateDeletionAuthorized({
      PROJECT_CONTROL_LEGACY_PITR_CONFIRMED: 'true',
    }), false)
    assert.equal(legacyDuplicateDeletionAuthorized({
      PROJECT_CONTROL_LEGACY_DESTRUCTIVE_CONFIRMATION: 'DELETE_CONFIRMED_LEGACY_DUPLICATES',
    }), false)
    assert.equal(legacyDuplicateDeletionAuthorized({
      PROJECT_CONTROL_LEGACY_PITR_CONFIRMED: 'true',
      PROJECT_CONTROL_LEGACY_DESTRUCTIVE_CONFIRMATION: 'DELETE_CONFIRMED_LEGACY_DUPLICATES',
    }), true)
  })
})
