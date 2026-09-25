import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Execute the actual migrations under production-like default grants. No
// credentials, provider requests, or production data are involved.
test('atomic retirement, exact revisions, worker fencing and immutable audit', async () => {
  const db = new PGlite()
  const transfer = '11111111-1111-4111-8111-111111111111'
  const project = '22222222-2222-4222-8222-222222222222'
  const event = '33333333-3333-4333-8333-333333333333'
  const later = '44444444-4444-4444-8444-444444444444'
  const version = '2026-09-01T00:00:00Z'
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table frameio_delivery_transfers(id uuid primary key, project_id uuid not null,
        dropbox_file_id text not null, dropbox_rev text not null, state text not null, updated_at timestamptz not null);
      create table dropbox_event_inbox(id uuid primary key, event_type text, payload jsonb,
        status text, next_attempt_at timestamptz default now(), created_at timestamptz default now(),
        claimed_at timestamptz, attempt_count int default 0, claim_token uuid, claimed_by text,
        updated_at timestamptz default now());
    `)
    await db.exec(await readFile(new URL('../supabase/migrations/20260925005401_frameio_transfer_retirement.sql', import.meta.url), 'utf8'))
    await db.query('insert into frameio_delivery_transfers values($1,$2,$3,$4,$5,$6)',
      [transfer, project, 'id:file', 'rev-old', 'processing', version])
    await db.query(`insert into dropbox_event_inbox(id,event_type,payload,status) values
      ($1,'frameio_delivery','{"dropboxId":"id:file","rev":"rev-old"}','complete'),
      ($2,'frameio_delivery','{"dropboxId":"id:file","rev":"rev-new"}','pending')`, [event, later])
    const retire = (dryRun = true, rev = 'rev-old', ids = [event], expected = version) => db.query<{receipt:{disposition:string}}>(
      'select retire_frameio_transfer($1,$2,$3,$4,$5,$6,$7,$8,$9) as receipt',
      [transfer, project, 'id:file', rev, expected, ids, 'Owner authorized historical retirement', 'test-owner', dryRun])
    const count = async () => (await db.query<{n:number}>('select count(*)::int n from frameio_transfer_retirements')).rows[0].n
    await db.exec('set role service_role')
    assert.equal((await retire()).rows[0].receipt.disposition, 'eligible')
    assert.equal(await count(), 0)
    await assert.rejects(retire(false, 'rev-new'), /identity mismatch/)
    await assert.rejects(retire(false, 'rev-old', []), /manifest changed/)
    await assert.rejects(retire(false, 'rev-old', [event], '2026-09-02T00:00:00Z'), /transfer changed/)
    await db.query("update dropbox_event_inbox set status='processing',claimed_at='2020-01-01' where id=$1", [event])
    await assert.rejects(retire(false), /in-flight worker/)
    await db.query("update dropbox_event_inbox set status='complete' where id=$1", [event])
    await db.query("update frameio_delivery_transfers set state='ready' where id=$1", [transfer])
    await assert.rejects(retire(false), /delivered transfer/)
    await db.query("update frameio_delivery_transfers set state='processing' where id=$1", [transfer])
    // Simulate a failure at the final write: the audit and transfer MUST roll back.
    await db.exec(`reset role;
      create function fail_inbox_write() returns trigger language plpgsql as $$
      begin raise exception 'injected inbox outage'; end; $$;
      create trigger fail_inbox before update on dropbox_event_inbox for each row execute function fail_inbox_write();
      set role service_role;`)
    await assert.rejects(retire(false), /injected inbox outage/)
    assert.equal(await count(), 0)
    assert.equal((await db.query<{retired_at:Date|null}>('select retired_at from frameio_delivery_transfers')).rows[0].retired_at, null)
    await db.exec('reset role; drop trigger fail_inbox on dropbox_event_inbox; set role service_role')
    assert.equal((await retire(false)).rows[0].receipt.disposition, 'retired')
    assert.equal((await retire(false)).rows[0].receipt.disposition, 'already_retired')
    assert.equal(await count(), 1)
    assert.equal((await db.query<{retired_at:Date|null}>('select retired_at from dropbox_event_inbox where id=$1', [later])).rows[0].retired_at, null)
    // Replay the old event: claim filters it out while the next revision remains live.
    await db.query("update dropbox_event_inbox set status='retryable' where id=$1", [event])
    assert.deepEqual((await db.query<{id:string}>('select id from claim_dropbox_events($1)', ['worker'])).rows.map(r => r.id), [later])
    await assert.rejects(db.query("update frameio_delivery_transfers set state='ready' where id=$1", [transfer]), /retired transfer/)
    for (const sql of ['update frameio_transfer_retirements set reason=reason', 'delete from frameio_transfer_retirements', 'truncate frameio_transfer_retirements']) {
      await assert.rejects(db.exec(sql), /permission denied/)
    }
    await db.query('delete from frameio_delivery_transfers where id=$1', [transfer])
    assert.equal(await count(), 1, 'audit survives source/project deletion')
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`)
      await assert.rejects(retire(false), /permission denied/)
    }
    await db.exec('reset role')
    await assert.rejects(db.exec('delete from frameio_transfer_retirements'), /append-only/)
  } finally { await db.close() }
})

test('heartbeat migration preserves success and enrollment across restarts and attempts', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table cron_heartbeats(cron_id text primary key,last_success_at timestamptz not null default now());`)
    await db.exec(await readFile(new URL('../supabase/migrations/20260925005342_cron_heartbeat_attempts.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20260925164550_batched_cron_registration.sql', import.meta.url), 'utf8'))
    await db.exec('set role service_role')
    const stamp = (kind: string|null, enabled = true) => db.query('select record_kit_cron($1,$2,$3,$4,$5)',
      ['dropbox-inbox-sweep', 'railway', enabled, {kind:'interval',label:'Inbox',maxAgeMin:15}, kind])
    const read = async () => (await db.query<{enrolled_at:Date;last_success_at:Date|null;enabled:boolean}>('select * from cron_heartbeats')).rows[0]
    await stamp('register')
    const enrolled = (await read()).enrolled_at
    await stamp('attempt')
    assert.equal((await read()).last_success_at, null)
    await stamp('success')
    const success = (await read()).last_success_at
    await db.query('select register_kit_crons($1,$2)', ['railway', [{ id: 'dropbox-inbox-sweep', enabled: true, schedule: {kind:'interval',label:'Inbox',maxAgeMin:15} }]])
    assert.deepEqual((await read()).last_success_at, success)
    await assert.rejects(db.query('select register_kit_crons($1,$2)', ['other', []]), /Invalid cron registration batch/)
    await stamp('register'); await stamp('attempt')
    assert.deepEqual((await read()).enrolled_at, enrolled)
    assert.deepEqual((await read()).last_success_at, success)
    await stamp('register', false)
    assert.equal((await read()).enabled, false)
    await stamp('register', true)
    assert.ok(Date.parse(String((await read()).enrolled_at)) >= Date.parse(String(enrolled)))
    await assert.rejects(stamp(null), /invalid cron registration/)
    await db.exec('reset role; set role anon')
    await assert.rejects(stamp('success'), /permission denied/)
    await assert.rejects(db.query('select register_kit_crons($1,$2)', ['railway', []]), /permission denied/)
  } finally { await db.close() }
})
