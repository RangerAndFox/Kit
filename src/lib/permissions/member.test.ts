import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memberCanAccessProject, resolveWorkspaceMember } from './member'

function fake(role: string, assigned = true, fail = false) {
  const filters: Array<[string, string, unknown]> = []
  const db = { from(table: string) {
    const where: Record<string, unknown> = {}
    const query = {
      select() { return query },
      eq(key: string, value: unknown) { where[key] = value; filters.push([table, key, value]); return query },
      async maybeSingle() {
        if (fail) return { data: null, error: new Error('Unavailable') }
        if (where.workspace_id !== 'workspace') return { data: null, error: null }
        if (table === 'team_members') return { data: where.auth_user_id === 'auth-user' ? { id: 'member-id', role } : null, error: null }
        if (table === 'projects') return { data: where.id === 'project' ? { id: 'project' } : null, error: null }
        return { data: assigned && where.team_member_id === 'member-id' ? { id: 'access' } : null, error: null }
      },
    }
    return query
  } } as unknown as SupabaseClient
  return { db, filters }
}

for (const role of ['founder', 'producer', 'artist', 'freelancer']) {
  it(`${role}: resolves auth ID to member ID and confines access to the workspace`, async () => {
    const { db, filters } = fake(role)
    const member = await resolveWorkspaceMember(db, 'auth-user', 'workspace')
    assert.ok(member)
    assert.equal(await memberCanAccessProject(db, member, 'workspace', 'project'), true)
    assert.equal(await memberCanAccessProject(db, member, 'other-workspace', 'project'), false)
    if (role !== 'founder') assert.ok(filters.some(([table, key, value]) => table === 'project_access' && key === 'team_member_id' && value === 'member-id'))
  })
}
it('denies unassigned, removed, unknown-role, and unavailable member lookups', async () => {
  const { db } = fake('artist', false)
  const member = await resolveWorkspaceMember(db, 'auth-user', 'workspace')
  assert.ok(member)
  assert.equal(await memberCanAccessProject(db, member, 'workspace', 'project'), false)
  assert.equal(await resolveWorkspaceMember(db, 'removed-user', 'workspace'), null)
  assert.equal(await resolveWorkspaceMember(fake('owner-from-client').db, 'auth-user', 'workspace'), null)
  assert.equal(await resolveWorkspaceMember(fake('founder', true, true).db, 'auth-user', 'workspace'), null)
})
