/**
 * Structural regression guard for routes disabled after the public-write audit.
 * Run: npx tsx --test src/app/api/public-write-boundary.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GET as frameioCallback } from './auth/callback/route'
import { POST as generateScript } from './toolkit/script/route'
import { POST as generateSow } from './toolkit/sow/route'
import { POST as generateWorkback } from './toolkit/workback/route'

const ROUTES = [
  'src/app/api/auth/callback/route.ts',
  'src/app/api/toolkit/script/route.ts',
  'src/app/api/toolkit/sow/route.ts',
  'src/app/api/toolkit/workback/route.ts',
]

describe('audited public write routes are structurally disabled', () => {
  it('returns the same inert response without reading caller-controlled scope', async () => {
    const responses = await Promise.all([
      frameioCallback(),
      generateScript(),
      generateSow(),
      generateWorkback(),
    ])
    for (const response of responses) {
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'not_found' })
    }
  })

  it('imports only next/server and cannot reach a DB, model, or provider', () => {
    for (const path of ROUTES) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      const imports = [...source.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1])
      assert.deepEqual(imports, ['next/server'], path)
      for (const forbidden of [
        'createAdminClient',
        'supabase',
        '@anthropic-ai',
        'FRAMEIO_ADOBE_CLIENT_SECRET',
        'request.json(',
        'request.text(',
        'searchParams.get(',
      ]) {
        assert.ok(!source.includes(forbidden), `${path} must not contain ${forbidden}`)
      }
    }
  })
})
