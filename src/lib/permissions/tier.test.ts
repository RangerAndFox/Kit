import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberAccessTier, roleAssignment } from './tier'

test('CD and producer titles share project access, never admin', () => {
  for (const role of ['cd', 'creative_director', 'producer']) assert.equal(memberAccessTier(role, 'artist'), 'producer')
  for (const role of ['designer', 'creative', 'other', 'unknown']) assert.equal(memberAccessTier(role, 'artist'), 'artist')
  assert.equal(memberAccessTier('other', 'producer'), 'producer')
  assert.equal(memberAccessTier('admin', 'founder'), 'admin')
})
test('role writes use actual database enums and allow effective demotion', () => {
  assert.deepEqual(roleAssignment('creative_director'), { role: 'creative_director', permission_tier: 'producer' })
  assert.deepEqual(roleAssignment('founder'), { role: 'admin', permission_tier: 'founder' })
  const demoted = roleAssignment('artist')
  assert.equal(memberAccessTier(demoted.role, demoted.permission_tier), 'artist')
  assert.throws(() => roleAssignment('superuser'))
})
