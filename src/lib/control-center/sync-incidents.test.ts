import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

it('records private incidents, gates sustained failures, and deduplicates named recovery alerts', async () => {
  const db = new PGlite()
  const project = '11111111-1111-4111-8111-111111111111'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table projects(id uuid primary key,project_code text,name text);
      create table project_control_bindings(project_id uuid primary key,error_notified_key text);
      create table kit_control_outbox(id uuid primary key default gen_random_uuid(),project_id uuid,kind text,payload jsonb,status text default 'pending');
      grant all on projects,project_control_bindings,kit_control_outbox to service_role;`)
    await db.query('insert into projects values($1,$2,$3)', [project, '2601', 'Test <@everyone>'])
    await db.query('insert into project_control_bindings values($1,null)', [project])
    await db.exec(await readFile('supabase/migrations/20260916002753_sync_incident_alert_policy.sql', 'utf8'))
    const call = (key: string, channel = 'DADMIN') => db.query<{ queued: boolean }>('select enqueue_project_sync_alert($1,$2,$3,$4) as queued', [project, key, channel, 'UNSAFE ignored legacy text'])
    const count = async () => Number((await db.query<{ n: number }>('select count(*) as n from kit_control_outbox')).rows[0].n)
    await db.exec('set role service_role')
    assert.equal((await call('error:429 secret-token-value')).rows[0].queued, false)
    await call('error:429'); await call('error:429')
    assert.equal(await count(), 0, 'rapid retries stay quiet')
    await call('ok:recovered')
    assert.equal(await count(), 0, 'transient recovery stays quiet')
    const history = (await db.query<{ reason: string; resolved_at: string }>('select reason,resolved_at from project_sync_incidents')).rows
    assert.equal(history[0].reason, 'Provider rate limit')
    assert.ok(history[0].resolved_at)
    await call('error:timeout')
    await db.exec("update project_sync_incidents set first_failed_at=now()-interval '6 minutes' where resolved_at is null")
    assert.equal((await call('error:timeout')).rows[0].queued, false, 'time alone does not alert')
    await assert.rejects(call('error:timeout', 'CPUBLIC'), /Private sync alert/)
    assert.equal(await count(), 0)
    assert.equal((await call('error:timeout')).rows[0].queued, true)
    await call('error:unavailable')
    assert.equal(await count(), 1, 'changed reason does not repeat the alert')
    await call('ok:newhash'); await call('ok:newhash')
    assert.equal(await count(), 2, 'one recovery per sustained incident')
    const messages = (await db.query<{ id: string; payload: Record<string, string> }>('select id,payload from kit_control_outbox')).rows
    const failure = messages.find(x => !x.payload.priorAlertId)!
    const recovery = messages.find(x => x.payload.priorAlertId)!
    assert.equal(recovery.payload.priorAlertId, failure.id)
    assert.match(failure.payload.text, /2601 — Test &lt;@everyone&gt;/)
    assert.match(failure.payload.text, /control-center\/projects\/11111111/)
    assert.doesNotMatch(JSON.stringify(messages), /secret-token|UNSAFE/)
    await db.exec('reset role; set role authenticated')
    await assert.rejects(db.query('select * from project_sync_incidents'), /permission denied/)
    await assert.rejects(call('error:429'), /permission denied/)
    await db.exec('reset role; set role anon')
    await assert.rejects(db.query('select * from project_sync_incidents'), /permission denied/)
    await assert.rejects(call('error:429'), /permission denied/)
  } finally { await db.close() }
})
