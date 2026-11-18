import { it } from 'node:test'
import assert from 'node:assert/strict'
import { canViewControlCenter } from './access-policy'
it('requires current leadership membership and rejects deactivated admins', () => {
  assert.equal(canViewControlCenter(null), false)
  assert.equal(canViewControlCenter({ role: 'artist', permission_tier: null, is_active: true }), false)
  assert.equal(canViewControlCenter({ role: 'admin', permission_tier: null, is_active: false }), false)
  assert.equal(canViewControlCenter({ role: 'admin', permission_tier: null, is_active: true }), true)
  assert.equal(canViewControlCenter({ role: 'founder', permission_tier: null, is_active: null }), true)
  assert.equal(canViewControlCenter({ role: 'admin', permission_tier: 'artist', is_active: true }), false)
})
