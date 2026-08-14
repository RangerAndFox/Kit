/**
 * Tests for the DISABLED POST /api/toolkit/dispatch.
 *
 * Two guarantees:
 *   1. behavioral — every request gets the fixed disabled response;
 *   2. structural — the module cannot reach a database write, work dispatch, or
 *      external action, because it does not import anything that can. The
 *      structural assertion is what keeps the disable durable: a future edit
 *      that re-adds a side-effect import fails this test.
 *
 * Run: npx tsx --test src/app/api/toolkit/dispatch/route.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POST } from './route'

const ROUTE_SOURCE = readFileSync(join(process.cwd(), 'src/app/api/toolkit/dispatch/route.ts'), 'utf8')

function req(body?: unknown): Request {
  return new Request('https://kit.example/api/toolkit/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /api/toolkit/dispatch — disabled response', () => {
  it('returns the fixed 404 disabled response', async () => {
    const res = await POST(req({ tool: 'sow', projectId: 'p1', workspaceId: 'w1' }))
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'not_found' })
  })

  it('returns the same response for a caller-supplied workspaceId', async () => {
    const foreign = await POST(req({ tool: 'sow', projectId: 'p1', workspaceId: 'some-other-workspace' }))
    const none = await POST(req({ tool: 'sow' }))
    assert.equal(foreign.status, 404)
    assert.equal(await foreign.text(), await none.text())
  })

  it('returns the same response for an empty body and for no body', async () => {
    const empty = await POST(req({}))
    const missing = await POST(req())
    assert.equal(empty.status, missing.status)
    assert.equal(await empty.text(), await missing.text())
  })
})

describe('POST /api/toolkit/dispatch — structurally incapable of side effects', () => {
  it('imports nothing that can write, dispatch, or call an external service', () => {
    const forbidden = [
      '@/lib/supabase',
      'supabase',
      'managed-agents',
      'session-manager',
      'agent-registry',
      'AGENT_KEYS',
      '@anthropic-ai',
    ]
    for (const specifier of forbidden) {
      assert.ok(
        !ROUTE_SOURCE.includes(`from '${specifier}`) && !ROUTE_SOURCE.includes(`require('${specifier}`),
        `disabled route must not import ${specifier}`,
      )
    }
  })

  it('imports only next/server', () => {
    const imports = [...ROUTE_SOURCE.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1])
    assert.deepEqual(imports, ['next/server'])
  })

  it('never reads the request body', () => {
    for (const reader of ['request.json(', 'request.text(', 'request.formData(', 'request.arrayBuffer(']) {
      assert.ok(!ROUTE_SOURCE.includes(reader), `disabled route must not call ${reader})`)
    }
  })

  it('exports no method other than POST', () => {
    const exported = [...ROUTE_SOURCE.matchAll(/export\s+async\s+function\s+([A-Z]+)/g)].map((m) => m[1])
    assert.deepEqual(exported, ['POST'])
  })
})
