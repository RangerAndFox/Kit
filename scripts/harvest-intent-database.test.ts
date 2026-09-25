import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('billing ledger permits one writer, retains ambiguous holds, and requires consistent receipts', async () => {
  const db = new PGlite()
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;')
    await db.exec(await readFile(new URL('../supabase/migrations/20260925162518_harvest_time_intent_claims.sql', import.meta.url), 'utf8'))
    const a = '00000000-0000-0000-0000-000000000001'
    const b = '00000000-0000-0000-0000-000000000002'
    const call = async (owner: string, action: string, id: number | null = null) => (await db.query<{ ok: boolean }>('select record_harvest_time_intent($1,$2,$3,$4,$5) as ok', ['account','intent',owner,action,id])).rows[0].ok
    assert.equal(await call(a, 'claim'), true)
    assert.equal(await call(b, 'claim'), false)
    assert.equal(await call(b, 'reject'), false)
    assert.equal(await call(a, 'reject'), true)
    assert.equal(await call(b, 'claim'), true)
    await assert.rejects(call(a, 'commit', 123), /conflict/)
    assert.equal(await call(b, 'commit', 123), true)
    assert.equal(await call(a, 'claim'), false)
    assert.equal(await call(a, 'reconcile', 123), true)
    await assert.rejects(call(a, 'reconcile', 456), /conflict/)
    const permissions = await db.query<{ can_execute: boolean; can_select: boolean }>("select has_function_privilege('anon','record_harvest_time_intent(text,text,uuid,text,bigint)','execute') can_execute,has_table_privilege('authenticated','harvest_time_intents','select') can_select")
    assert.deepEqual(permissions.rows[0], { can_execute: false, can_select: false })
  } finally { await db.close() }
})
