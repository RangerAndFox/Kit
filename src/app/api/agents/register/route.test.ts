import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeAgentRegistration } from './auth'

describe('agent registration authentication', () => {
  it('fails closed when the dedicated secret is absent or mismatched', () => {
    assert.equal(authorizeAgentRegistration('', undefined), false)
    assert.equal(authorizeAgentRegistration('anything', undefined), false)
    assert.equal(authorizeAgentRegistration('wrong', 'dedicated-secret'), false)
  })

  it('accepts only the dedicated exact secret', () => {
    assert.equal(authorizeAgentRegistration('dedicated-secret', 'dedicated-secret'), true)
  })
})
