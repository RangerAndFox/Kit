import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertProfileOutsideSyncedStorage } from './profile-security.js'

describe('persistent browser profile storage boundary', () => {
  it('rejects the sync root and every descendant', () => {
    assert.throws(() => assertProfileOutsideSyncedStorage('/studio/Dropbox', '/studio/Dropbox'))
    assert.throws(() => assertProfileOutsideSyncedStorage('/studio/Dropbox/.behance-profile', '/studio/Dropbox'))
  })

  it('allows an application-support directory outside synced storage', () => {
    assert.doesNotThrow(() => assertProfileOutsideSyncedStorage('/Users/studio/Library/Application Support/Kit/BehanceProfile', '/Users/studio/Dropbox'))
  })
})
