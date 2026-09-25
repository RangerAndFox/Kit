import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('notification holds preserve failures, require evidence, and audit is service-only/append-only', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table elevenlabs_studio_jobs(id uuid primary key, status text, updated_at timestamptz default now(), slack_notified_at timestamptz);
      create function reject_frameio_retirement_audit_mutation() returns trigger language plpgsql as $$
      begin raise exception 'retirement audit is append-only'; end; $$;`)
    await db.exec(await readFile(new URL('../supabase/migrations/20260925134654_notification_dispositions.sql', import.meta.url), 'utf8'))
    await db.exec(`insert into elevenlabs_studio_jobs(id,status) values('11111111-1111-4111-8111-111111111111','failed')`)
    await assert.rejects(db.exec("update elevenlabs_studio_jobs set slack_notification_disposition='manual_review'"), /notification_disposition_evidence/)
    await db.exec(`update elevenlabs_studio_jobs set slack_notification_disposition='manual_review',
      slack_notification_disposition_reason='Owner requested no historical resend',
      slack_notification_disposition_by='owner',slack_notification_disposition_at=now()`)
    await assert.rejects(db.exec('update elevenlabs_studio_jobs set slack_notified_at=now()'), /notification_disposition_evidence/)
    assert.equal((await db.query<{ status: string }>('select status from elevenlabs_studio_jobs')).rows[0].status, 'failed')
    await db.exec(`set role service_role;
      insert into queue_disposition_audit(queue_name,record_id,disposition,reason,actor,prior_status)
      values('elevenlabs_studio_jobs','11111111-1111-4111-8111-111111111111','manual_review','Owner decision','owner','failed')`)
    for (const sql of ['delete from queue_disposition_audit', 'update queue_disposition_audit set reason=reason', 'truncate queue_disposition_audit']) {
      await assert.rejects(db.exec(sql), /permission denied/)
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`)
      await assert.rejects(db.exec('select * from queue_disposition_audit'), /permission denied/)
    }
    await db.exec('reset role')
    await assert.rejects(db.exec('delete from queue_disposition_audit'), /append-only/)
    assert.equal((await db.query<{relrowsecurity:boolean}>("select relrowsecurity from pg_class where relname='queue_disposition_audit'")).rows[0].relrowsecurity, true)
  } finally { await db.close() }
})
