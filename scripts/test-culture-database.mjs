// Isolated PostgreSQL smoke test. Install @electric-sql/pglite in a temporary
// directory, then set CULTURE_PGLITE_PATH to its dist/index.js. No network/keys.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
if (!process.env.CULTURE_PGLITE_PATH) throw new Error('Set CULTURE_PGLITE_PATH to a locally installed PGlite dist/index.js')
const { PGlite } = await import(pathToFileURL(process.env.CULTURE_PGLITE_PATH).href)
const db = new PGlite()
const workspace = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const owner = '44444444-4444-4444-8444-444444444444'
const secondOwner = '55555555-5555-4555-8555-555555555555'
const item = { id, revision: 0, kind: 'custom', name: 'Studio wins', briefing: 'Tiny victories', channel_id: 'C12345678', template_id: 'rotation', status: 'draft', schedule: 'once', month_day: null, weekday: null, fire_date: '2026-09-14', local_time: '09:00', timezone: 'America/Los_Angeles', person_id: null, person_name: null }
const save = (row, ws = workspace, confirm = true) => db.query('select * from public.save_culture_meme($1,$2,$3::jsonb,$4)', [ws, 'admin-fixture', JSON.stringify(row), confirm])
const claim = (revision, key, by = owner, ws = workspace) => db.query('select case when claim.id is null then null else to_jsonb(claim) end as job from public.claim_culture_post($1,$2,$3,$4,$5) claim', [ws, id, revision, key, by])
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table public.workspaces(id uuid primary key,slack_team_id text);')
  await db.query('insert into public.workspaces values($1,$2)', [workspace, 'T12345678'])
  await db.exec(await readFile(new URL('../supabase/migrations/20260914131527_culture_center.sql', import.meta.url), 'utf8'))
  const cutoff = new Date(Date.now() + 3600000).toISOString()
  const initialize = () => db.query('select public.initialize_culture($1,$2,$3,$4,$5,$6::jsonb) as initialized', [workspace, 'admin-fixture', 'C12345678', 'America/Los_Angeles', cutoff, JSON.stringify([])])
  assert.equal((await initialize()).rows[0].initialized, true)
  assert.equal((await initialize()).rows[0].initialized, false)
  await assert.rejects(save({ ...item, status: 'enabled' }), /culture_draft_required/)
  const created = (await save(item)).rows[0]
  assert.equal(created.revision, 1)
  assert.equal((await claim(1, 'day')).rows[0].job, null)
  await assert.rejects(save({ ...item, revision: 1, status: 'enabled' }, workspace, false), /culture_review_required/)
  const enabled = (await save({ ...item, revision: 1, status: 'enabled' })).rows[0]
  assert.equal(enabled.revision, 2)
  assert.equal((await claim(2, 'day')).rows[0].job, null, 'Cutover must block early posts')
  await db.query("update public.culture_workspaces set starts_at=now()-interval '1 minute' where workspace_id=$1", [workspace])
  await assert.rejects(save({ ...item, revision: 1 }), /culture_edit_conflict/)
  const job = (await claim(2, 'day')).rows[0].job
  assert.ok(job.id)
  assert.equal((await claim(2, 'day', secondOwner)).rows[0].job, null)
  assert.equal((await db.query('select public.begin_culture_send($1,$2) as ok', [job.id, secondOwner])).rows[0].ok, false)
  assert.equal((await db.query('select public.begin_culture_send($1,$2) as ok', [job.id, owner])).rows[0].ok, true)
  await assert.rejects(save({ ...item, revision: 2, status: 'paused' }), /culture_send_in_progress/)
  await db.query("update public.culture_posts set lease_until=now()-interval '1 minute' where id=$1", [job.id])
  assert.equal((await claim(2, 'day', secondOwner)).rows[0].job, null)
  assert.equal((await db.query('select status from public.culture_posts where id=$1', [job.id])).rows[0].status, 'review')
  const prepared = (await claim(2, 'next-day')).rows[0].job
  await save({ ...item, revision: 2, status: 'paused' })
  assert.equal((await db.query('select public.begin_culture_send($1,$2) as ok', [prepared.id, owner])).rows[0].ok, false)
  assert.equal((await db.query('select status from public.culture_posts where id=$1', [prepared.id])).rows[0].status, 'cancelled')
  assert.equal((await db.query('select count(*)::int as count from public.culture_audit')).rows[0].count, 3)
  await db.query('insert into public.workspaces values($1,$2)', [other, 'T87654321'])
  await db.query('insert into public.culture_workspaces(workspace_id,starts_at,default_channel_id,timezone) values($1,now(),$2,$3)', [other, 'C87654321', 'UTC'])
  await assert.rejects(save(item, other), /culture_not_found/)
  assert.equal((await claim(3, 'other-day', owner, other)).rows[0].job, null)
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query('select * from public.culture_memes'), /permission denied/)
    await assert.rejects(claim(3, 'forbidden'), /permission denied/)
    await db.exec('reset role')
  }
  const security = await db.query("select relname,relrowsecurity from pg_class where relname in ('culture_workspaces','culture_memes','culture_posts','culture_audit')")
  assert.equal(security.rows.length, 4)
  assert.ok(security.rows.every(row => row.relrowsecurity))
  console.log('PASS: migration, atomic initialization/audit, cutover, draft/review gates, revision conflicts, claims, fencing, unknown sends, pause and tenant/role isolation')
} finally { await db.close() }
