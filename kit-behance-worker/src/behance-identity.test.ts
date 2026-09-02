import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { behanceIdentityError, behanceProfileSlugFromHref, behanceUsernameFromState } from './behance-identity.js'

describe('Behance identity guard', () => {
  it('extracts a profile slug only from Behance profile URLs', () => {
    assert.equal(behanceProfileSlugFromHref('https://www.behance.net/rangerandfox'), 'rangerandfox')
    assert.equal(behanceProfileSlugFromHref('/RangerAndFox'), 'rangerandfox')
    assert.equal(behanceProfileSlugFromHref('https://www.behance.net/portfolio/editor?project_id=1'), null)
    assert.equal(behanceProfileSlugFromHref('https://example.com/rangerandfox'), null)
  })

  it('reads the authenticated username from Behance page state', () => {
    assert.equal(behanceUsernameFromState('{"loggedInUser":{"id":108850919,"first_name":"Ranger","last_name":"& Fox","username":"rangerandfox"}}'), 'rangerandfox')
    assert.equal(behanceUsernameFromState('{}'), null)
  })

  it('rejects signed-out, unverified, and wrong profiles', () => {
    assert.match(behanceIdentityError({ signedIn: false, profileSlug: null, expectedProfileSlug: 'rangerandfox' }) || '', /signed out/i)
    assert.match(behanceIdentityError({ signedIn: true, profileSlug: null, expectedProfileSlug: 'rangerandfox' }) || '', /could not verify/i)
    assert.match(behanceIdentityError({ signedIn: true, profileSlug: 'someoneelse', expectedProfileSlug: 'rangerandfox' }) || '', /someoneelse.*rangerandfox/i)
    assert.equal(behanceIdentityError({ signedIn: true, profileSlug: 'rangerandfox', expectedProfileSlug: 'rangerandfox' }), null)
  })
})
