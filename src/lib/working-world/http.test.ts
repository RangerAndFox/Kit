import { it } from 'node:test'
import assert from 'node:assert/strict'
import { handleWorld } from './http'
import { buildWorldSnapshot } from './model'
const access = { userId: 'verified-user', workspaceId: 'verified-workspace', workspaceName: 'R&F', role: 'admin', displayName: 'Steve' }
const snapshot = buildWorldSnapshot({ workspaceName: 'R&F', observedAt: '2026-11-18T03:00:00Z', tasks: [], sources: [] })
it('denies unauthenticated access before reading any operational data', async () => {
  let reads = 0
  const r = await handleWorld(new Request('https://kit.test/api/working-world'), { access: async () => null, load: async () => { reads++; return snapshot } })
  assert.equal(r.status, 403); assert.equal(reads, 0)
})
it('takes workspace and principal only from server-verified access', async () => {
  const r = await handleWorld(new Request('https://kit.test/api/working-world?workspaceId=other'), { access: async () => access, load: async args => { assert.equal(args.workspaceId, access.workspaceId); return snapshot } })
  assert.equal(r.status, 200); assert.match(r.headers.get('cache-control') || '', /private, no-store/)
})
it('malformed, oversized, unknown-agent and cross-origin questions do not load data', async () => {
  const invalid = [
    { body: '{', origin: 'https://kit.test' }, { body: JSON.stringify({ question: 'x'.repeat(4100) }), origin: 'https://kit.test' },
    { body: JSON.stringify({ question: 'Hello', agentId: 'evil' }), origin: 'https://kit.test' }, { body: JSON.stringify({ question: 'Hi' }), origin: 'https://evil.test' },
  ]
  for (const item of invalid) {
    let reads = 0
    const r = await handleWorld(new Request('https://kit.test/api/working-world', { method: 'POST', headers: { 'content-type': 'application/json', origin: item.origin }, body: item.body }), { access: async () => access, load: async () => { reads++; return snapshot } })
    assert.ok([400, 403].includes(r.status)); assert.equal(reads, 0)
  }
})
it('ignores submitted snapshots, sessions and workspace IDs when answering', async () => {
  const r = await handleWorld(new Request('https://kit.test/api/working-world', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What is blocked?', workspaceId: 'other', snapshot: { secrets: 'never trust' }, session: 'javascript:evil' }) }), { access: async () => access, load: async args => { assert.equal(args.workspaceId, access.workspaceId); return snapshot } })
  assert.equal(r.status, 200); const answer = await r.json(); assert.match(answer.text, /Read-only diagnostics/); assert.ok(!JSON.stringify(answer).includes('never trust'))
})
it('source errors are unknown and never disclose provider bodies', async () => {
  const r = await handleWorld(new Request('https://kit.test/api/working-world'), { access: async () => access, load: async () => { throw new Error('secret-provider-token') } })
  assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('secret-provider-token'))
})
