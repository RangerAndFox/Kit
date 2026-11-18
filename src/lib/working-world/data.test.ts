import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadWorkingWorld, WORLD_SOURCE_SPECS } from './data'

type Row = Record<string, unknown>
type Result = { data: Row[] | null; error: { message: string } | null }
interface Call { table: string; methods: Array<{ name: string; args: unknown[] }> }
function fake(overrides: Record<string, Result> = {}) {
  const calls: Call[] = []
  const fixtures: Record<string, Result> = {
    projects: { data: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', project_code: '2646', name: 'Foundry' }], error: null },
    team_members: { data: [{ slack_user_id: 'U123456' }], error: null }, workspaces: { data: [{ id: 'workspace-a' }], error: null }, ...overrides,
  }
  class Query implements PromiseLike<Result> {
    call: Call
    constructor(table: string) { this.call = { table, methods: [] }; calls.push(this.call) }
    method(name: string, args: unknown[]) { this.call.methods.push({ name, args }); return this }
    select(...args: unknown[]) { return this.method('select', args) }
    eq(...args: unknown[]) { return this.method('eq', args) }
    in(...args: unknown[]) { return this.method('in', args) }
    not(...args: unknown[]) { return this.method('not', args) }
    or(...args: unknown[]) { return this.method('or', args) }
    order(...args: unknown[]) { return this.method('order', args) }
    gte(...args: unknown[]) { return this.method('gte', args) }
    limit(...args: unknown[]) { return this.method('limit', args) }
    abortSignal(...args: unknown[]) { return this.method('abortSignal', args) }
    then<T = Result, E = never>(resolve?: ((v: Result) => T | PromiseLike<T>) | null, reject?: ((e: unknown) => E | PromiseLike<E>) | null): PromiseLike<T | E> {
      return Promise.resolve(fixtures[this.call.table] || { data: [], error: null }).then(resolve, reject)
    }
  }
  return { calls, client: { from: (table: string) => new Query(table) } as unknown as SupabaseClient }
}
const scope = { workspaceId: 'workspace-a', workspaceName: 'R&F' }
it('all workspace/project/member tables are scoped before the service-role read', async () => {
  const db = fake(); await loadWorkingWorld(scope, db.client)
  for (const spec of WORLD_SOURCE_SPECS) {
    const matching = db.calls.filter(c => c.table === spec.table)
    assert.ok(matching.length)
    for (const call of matching) {
      const scopeFilter = spec.scope === 'workspace' ? { name: 'eq', args: ['workspace_id', scope.workspaceId] }
        : spec.scope === 'project' ? { name: 'in', args: ['project_id', ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']] }
          : { name: 'in', args: ['slack_user_id', ['U123456']] }
      assert.ok(call.methods.some(m => JSON.stringify(m) === JSON.stringify(scopeFilter)), spec.id)
      assert.ok(call.methods.some(m => m.name === 'limit' && m.args[0] === 26))
      assert.ok(!call.methods.some(m => m.name === 'select' && m.args[0] === '*'))
    }
  }
})
it('studio-wide health is withheld when more than one workspace exists', async () => {
  const db = fake({ workspaces: { data: [{ id: 'workspace-a' }, { id: 'workspace-b' }], error: null } })
  const data = await loadWorkingWorld(scope, db.client)
  assert.ok(!db.calls.some(c => c.table === 'system_health'))
  assert.equal(data.sources.find(s => s.id === 'health')?.available, false)
  assert.equal(data.agents.find(a => a.id === 'delivery')?.state, 'unknown')
})
it('missing identity maps never degrade into unscoped legacy reads', async () => {
  const db = fake({ projects: { data: null, error: { message: 'offline' } }, team_members: { data: null, error: { message: 'offline' } } })
  const data = await loadWorkingWorld(scope, db.client)
  assert.ok(!db.calls.some(c => ['freelancer_onboardings', 'daily_hours_checkins'].includes(c.table)))
  assert.equal(data.agents.find(a => a.id === 'people')?.state, 'unknown')
  assert.equal(data.agents.find(a => a.id === 'finance')?.state, 'unknown')
})
it('source errors are isolated and bounded queues report truncation honestly', async () => {
  const rows = Array.from({ length: 26 }, (_, i) => ({ id: `upload-${i}`, state: 'awaiting', source_path: `/folder/${i}.mp4`, updated_at: new Date().toISOString() }))
  const db = fake({ frame_upload_approvals: { data: rows, error: null }, archive_jobs: { data: null, error: { message: 'secret-raw-provider-output' } } })
  const data = await loadWorkingWorld(scope, db.client)
  assert.equal(data.sources.find(s => s.id === 'uploads')?.truncated, true)
  assert.equal(data.agents.find(a => a.id === 'archive')?.state, 'unknown')
  assert.equal(data.agents.find(a => a.id === 'delivery')?.tasks.length, 25)
  assert.ok(!JSON.stringify(data).includes('secret-raw-provider-output'))
})
it('missing health evidence is unknown and only relevant providers are queried', async () => {
  const db = fake()
  const data = await loadWorkingWorld(scope, db.client)
  assert.equal(data.agents.find(a => a.id === 'delivery')?.state, 'unknown')
  const health = db.calls.find(c => c.table === 'system_health')!
  assert.ok(health.methods.some(m => m.name === 'in' && m.args[0] === 'key'))
  assert.ok(health.methods.some(m => m.name === 'limit' && m.args[0] === 8))
})
