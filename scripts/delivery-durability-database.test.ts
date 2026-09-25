import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('notification ownership uniqueness and cursor lease fencing are enforced in SQL', async () => {
  const db = new PGlite()
  try {
    await db.exec('create role anon; create role authenticated; create role service_role; create table seen_dropbox_files(dropbox_id text primary key,path text,notified_at timestamptz);')
    for (const file of ['20260925163858_delivery_notification_receipts.sql','20260925163859_delivery_queue_delta_cursor.sql']) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'))
    const a = '00000000-0000-0000-0000-000000000001', b = '00000000-0000-0000-0000-000000000002'
    const call = async (owner: string, action: string, cursor: string | null = null) => (await db.query<{ result: { claimed?: boolean; cursor?: string; ok?: boolean } }>('select delivery_queue_cursor($1,$2,$3) result', [owner,action,cursor])).rows[0].result
    assert.equal((await call(a,'claim')).claimed, true)
    assert.equal((await call(b,'claim')).claimed, false)
    await assert.rejects(call(b,'checkpoint','wrong'), /ownership lost/)
    assert.equal((await call(a,'checkpoint','saved')).ok, true)
    await db.exec("update delivery_queue_scan_state set lease_until=now()-interval '1 second'")
    assert.equal((await call(b,'claim')).cursor, 'saved')
    await assert.rejects(call(a,'release'), /ownership lost/)
    await db.query('insert into delivery_notification_receipts(delivery_key,owner,channel_id) values($1,$2,$3)', ['key',a,'C1'])
    await assert.rejects(db.query('insert into delivery_notification_receipts(delivery_key,owner,channel_id) values($1,$2,$3)', ['key',b,'C1']), /duplicate key/)
    await assert.rejects(db.exec("update delivery_notification_receipts set message_ts='1.2'"), /check constraint/)
    const permission = await db.query<{ allowed: boolean }>("select has_table_privilege('anon','delivery_notification_receipts','select') allowed")
    assert.equal(permission.rows[0].allowed, false)
  } finally { await db.close() }
})
