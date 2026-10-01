import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('replies have durable cross-checkin ownership without suppressing legitimate additional time', async () => {
  const db = new PGlite()
  const staff = '00000000-0000-0000-0000-000000000001'
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table staff(id uuid primary key);
      create table daily_hours_checkins(id uuid primary key, staff_id uuid references staff,
        dm_channel_id text, reply_ts text, status text, updated_at timestamptz default now());
      insert into staff values('${staff}');
      insert into daily_hours_checkins values
        ('${id(11)}','${staff}','DM','100.1','parsed',now()),
        ('${id(12)}','${staff}','DM','100.1','logged',now()),
        ('${id(13)}','${staff}','DM',null,'sent',now()),
        ('${id(14)}','${staff}','DM',null,'sent',now());`)
    await db.exec(`begin; ${await readFile(new URL('../supabase/migrations/20261001172856_checkin_reply_ownership.sql', import.meta.url), 'utf8')} commit;`)
    const current = async (n: number, status: string) =>
      (await db.query<{ ok: boolean }>('select checkin_action_is_current($1,$2) ok', [id(n), status])).rows[0].ok
    assert.equal(await current(11, 'parsed'), false, 'stale copy cannot remind or confirm')
    assert.equal(await current(12, 'parsed'), false, 'successful check-in cannot remind again')
    await assert.rejects(db.exec(`update daily_hours_checkins set status='logging' where id='${id(11)}'`), /checkin_reply_already_owned/)
    await db.exec(`update daily_hours_checkins set status='replied',reply_ts='200.1' where id='${id(13)}'`)
    await assert.rejects(db.exec(`update daily_hours_checkins set status='replied',reply_ts='200.1' where id='${id(14)}'`), /checkin_reply_already_owned/)
    assert.equal(await current(14, 'sent'), true, 'failed second claim rolls back row status')
    await db.exec(`update daily_hours_checkins set status='parsed' where id='${id(13)}'`)
    assert.equal(await current(13, 'parsed'), true)
    await db.exec(`update daily_hours_checkins set status='sent' where id='${id(13)}'`)
    await assert.rejects(db.exec(`update daily_hours_checkins set status='replied',reply_ts='200.1' where id='${id(13)}'`), /checkin_reply_already_owned/, 'Redo cannot resurrect the same event')
    await db.exec(`update daily_hours_checkins set status='replied',reply_ts='300.1' where id='${id(13)}'`)
    await assert.rejects(db.exec(`update daily_hours_checkins set status='replied',reply_ts='200.1' where id='${id(14)}'`), /checkin_reply_already_owned/, 'old cursor stays owned after a new reply')
    await assert.rejects(db.exec(`insert into daily_hours_checkins values('${id(15)}','${staff}','DM','300.1','parsed',now())`), /checkin_reply_already_owned/, 'adhoc fallback cannot reuse a consumed reply')
    await db.exec(`update daily_hours_checkins set status='replied',reply_ts='400.1' where id='${id(14)}';
      update daily_hours_checkins set status='parsed' where id in ('${id(13)}','${id(14)}');`)
    assert.equal(await current(14, 'parsed'), true, 'new separate reply remains confirmable')
    await db.exec(`update daily_hours_checkins set status='logging' where id='${id(13)}'`)
    assert.equal(await current(13, 'parsed'), false, 'reminder recheck sees concurrent confirmation')
    // Closing stale cards retains history, never invents a successful receipt.
    await db.exec(`update daily_hours_checkins set status='skipped' where id='${id(11)}'`)
    assert.equal(await current(11, 'parsed'), false)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.exec('select * from checkin_reply_claims'), /permission denied/)
      await assert.rejects(current(13, 'parsed'), /permission denied/)
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    await assert.rejects(db.exec('delete from checkin_reply_claims'), /permission denied/)
    await assert.rejects(db.exec('update checkin_reply_claims set reply_ts=reply_ts'), /permission denied/)
  } finally { await db.close() }
})
