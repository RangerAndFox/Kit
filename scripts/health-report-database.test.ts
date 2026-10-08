import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('health report completion is atomic, monotonic, replay-safe and service-only', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table system_health(key text primary key,status text not null check(status in ('up','down')),
        detail text,since timestamptz not null,checked_at timestamptz not null);`)
    await db.exec(await readFile(new URL('../supabase/migrations/20261008150249_health_report_reconciliation.sql', import.meta.url), 'utf8'))
    const insert = async (id: string, at: string, checks: unknown[], planned = true) => {
      await db.query('insert into health_reports(id, observed_at, payload, plan) values($1,$2,$3,$4)',
        [id, at, {}, planned ? { checks } : null])
    }
    await insert('unplanned', '2026-10-08T13:00:00Z', [], false)
    await assert.rejects(db.exec("select complete_health_report('unplanned')"), /no delivery plan/)
    await insert('unknown', '2026-10-08T13:00:00Z', [{ key: 'db', ok: false, unknown: true }])
    await db.exec("set role service_role; select complete_health_report('unknown'); reset role")
    assert.equal((await db.query<{ status: string }>('select status from system_health')).rows[0].status, 'unknown')
    await insert('up', '2026-10-08T13:10:00Z', [{ key: 'db', ok: true }])
    await db.exec("select complete_health_report('up'); select complete_health_report('up')")
    await insert('late', '2026-10-08T12:59:00Z', [{ key: 'db', ok: false }])
    await db.exec("select complete_health_report('late')")
    assert.equal((await db.query<{ status: string }>('select status from system_health')).rows[0].status, 'up')
    await insert('rollback', '2026-10-08T13:20:00Z', [{ key: 'db', ok: false }, { key: null, ok: false }])
    await assert.rejects(db.exec("select complete_health_report('rollback')"), /null value/)
    assert.equal((await db.query<{ status: string }>('select status from system_health')).rows[0].status, 'up')
    assert.equal((await db.query<{ completed_at: null }>("select completed_at from health_reports where id='rollback'")).rows[0].completed_at, null)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.exec('select * from health_reports'), /permission denied/)
      await assert.rejects(db.exec("select complete_health_report('unknown')"), /permission denied/)
      await db.exec('reset role')
    }
    assert.equal((await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname='health_reports'")).rows[0].relrowsecurity, true)
  } finally { await db.close() }
})
