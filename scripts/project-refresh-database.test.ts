import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('refresh queue coalesces clicks and atomically releases private receipts only after completion', async () => {
  const db = new PGlite()
  const project = '11111111-1111-4111-8111-111111111111'
  const workspace = '22222222-2222-4222-8222-222222222222'
  const token = '33333333-3333-4333-8333-333333333333'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table projects(id uuid primary key,workspace_id uuid,project_code text);
      create table project_control_bindings(project_id uuid primary key,creation_state text,error_notified_key text,last_synced_at timestamptz);
      create table kit_actions(id uuid primary key,workspace_id uuid,project_id uuid,action_type text,title text,body text,priority text,status text,requires_approval boolean,min_tier_to_view text,acted_at timestamptz);
      insert into projects values('${project}','${workspace}','2645-Microsoft');
      insert into project_control_bindings values('${project}','connected',null,'2026-10-10T02:15:00Z');`)
    for (const file of ['20260911151633_kit_control_outbox.sql', '20261010034624_project_refresh_controls.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'))
    }
    const queue = async (actor = 'UONE') => (await db.query<{ id: string }>(
      'select enqueue_slack_project_refresh($1,$2,$3,$4) as id', [workspace, project, actor, 'DPRIVATE'])).rows[0].id
    const id = await queue()
    assert.equal(await queue(), id)
    assert.equal(await queue('UTWO'), id)
    assert.equal((await db.query("select * from kit_control_outbox where kind='control_action'")).rows.length, 1)
    assert.equal((await db.query("select * from kit_control_outbox where kind='sync_alert'")).rows.length, 2)
    assert.equal((await db.query("select * from kit_control_outbox where kind='sync_alert' and next_attempt_at<=now()")).rows.length, 0)
    await assert.rejects(db.query('select enqueue_slack_project_refresh($1,$2,$3,$4)', [workspace, project, 'UONE', 'CPUBLIC']), /Invalid Slack identity/)
    await assert.rejects(db.query('select enqueue_slack_project_refresh($1,$2,$3,$4)', [token, project, 'UONE', 'DPRIVATE']), /not connected/)
    await db.query('select claim_control_outbox($1,$2)', [id, token])
    assert.equal((await db.query<{ done: boolean }>('select finish_slack_project_refresh($1,$2,$3) as done', [id, workspace, 'sent'])).rows[0].done, false)
    await db.query('select finish_slack_project_refresh($1,$2,$3)', [id, token, 'retry'])
    assert.equal((await db.query("select * from kit_control_outbox where kind='sync_alert' and next_attempt_at<=now()")).rows.length, 0)
    await db.query("update kit_control_outbox set next_attempt_at=now() where id=$1", [id])
    await db.query('select claim_control_outbox($1,$2)', [id, token])
    await db.query('select finish_slack_project_refresh($1,$2,$3)', [id, token, 'sent'])
    const receipts = (await db.query<{payload:{text:string}}>("select payload from kit_control_outbox where kind='sync_alert' and next_attempt_at<=now()")).rows
    assert.equal(receipts.length, 2)
    assert.match(receipts[0].payload.text, /2645-Microsoft synced successfully/)
    assert.match(receipts[0].payload.text, /10:15 PM/)
    const second = await queue()
    assert.notEqual(second, id)
    await db.query('select claim_control_outbox($1,$2)', [second, token])
    await db.query('select finish_slack_project_refresh($1,$2,$3)', [second, token, 'review'])
    const failed = (await db.query<{payload:{text:string}}>("select payload from kit_control_outbox where payload->>'refreshId'=$1", [second])).rows[0]
    assert.match(failed.payload.text, /could not finish syncing/)
    assert.doesNotMatch(failed.payload.text, /synced successfully/)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(queue(), /permission denied/)
      await db.exec('reset role')
    }
  } finally { await db.close() }
})
