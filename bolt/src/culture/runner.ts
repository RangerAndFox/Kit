import { createHash, randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import { cultureDb, workspaceForTeam, MEME_FIELDS, saveMeme, verifyDestination } from '../../../src/lib/culture/store'
import { dueKey, escapeSlack, localParts, memeSchema, newMeme, type Meme, type CultureWorkspace } from '../../../src/lib/culture/model'
import { deliverCulture } from '../../../src/lib/culture/delivery'
import { isStudioHoliday } from '../../../src/lib/culture/holidays'
import { CELEBRATION_TEMPLATES, postMeme } from '../memes/meme-engine'
import { postWeeklyTimesheetMeme, weekIndexFromMs } from '../memes/timesheet-meme'

const contexts = new WeakMap<App, { workspaceId: string; expires: number }>()
async function state(app: App): Promise<CultureWorkspace | null> {
  let context = contexts.get(app)
  if (!context || context.expires < Date.now()) {
    const auth = await app.client.auth.test()
    if (!auth.ok || !auth.team_id) throw new Error('Culture Slack identity could not be verified.')
    context = { workspaceId: await workspaceForTeam(auth.team_id), expires: Date.now() + 300000 }
    contexts.set(app, context)
  }
  const { data, error } = await cultureDb().from('culture_workspaces').select('*').eq('workspace_id', context.workspaceId).maybeSingle()
  // Only an unapplied migration means legacy mode. Outages must not revive old schedules.
  if (error?.code === '42P01' || error?.code === 'PGRST205') return null
  if (error) throw new Error('Culture schedule lookup failed; posting paused.')
  return data
}
const active = (config: CultureWorkspace | null): config is CultureWorkspace => !!config && Date.parse(config.starts_at) <= Date.now()
export async function cultureIsActive(app: App): Promise<boolean> { return active(await state(app)) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)

async function items(config: CultureWorkspace): Promise<Meme[]> {
  const { data, error } = await cultureDb().from('culture_memes').select(MEME_FIELDS).eq('workspace_id', config.workspace_id).order('created_at').limit(500)
  if (error) throw new Error('Culture rules could not be read.')
  return (data || []).map(row => memeSchema.parse(row))
}

export async function postCultureItem(app: App, config: CultureWorkspace, item: Meme, key: string, projectName?: string): Promise<boolean> {
  const db = cultureDb()
  const owner = randomUUID()
  const { data: job, error } = await db.rpc('claim_culture_post', { p_workspace: config.workspace_id, p_meme: item.id, p_revision: item.revision, p_key: key, p_owner: owner })
  if (error) throw new Error('Culture posting claim failed.')
  if (!job?.id) return false
  return deliverCulture({
    beginSend: async () => {
      const result = await db.rpc('begin_culture_send', { p_post: job.id, p_owner: owner })
      if (result.error) throw new Error('Culture send checkpoint failed.')
      return result.data === true
    },
    prepareAndPost: async beforeSend => {
      await verifyDestination(config.workspace_id, item.channel_id)
      if (item.kind === 'timesheet') return postWeeklyTimesheetMeme(app, weekIndexFromMs(Date.now()), { channel: item.channel_id, templateId: item.template_id, beforeSend, clientMsgId: job.id })
      const occasion = item.kind === 'birthday' ? 'birthday' : item.kind === 'holiday' ? 'holiday' : item.kind === 'delivery' ? 'delivery_prepared' : undefined
      const headline = item.kind === 'birthday' ? `:birthday: *Happy birthday, ${escapeSlack(item.person_name || 'teammate')}!*`
        : item.kind === 'delivery' ? ':package: *Delivery files ready — nice work, team!*' : `:tada: *${escapeSlack(item.name)}*`
      // Project names are intentionally not sent to the team channel or renderer.
      void projectName
      return postMeme(app, { channel: item.channel_id, headline, briefing: item.briefing || item.name,
        publicOccasion: occasion, templateIndex: item.template_id === 'rotation' ? undefined : CELEBRATION_TEMPLATES.findIndex(t => t.id === item.template_id),
        beforeSend, clientMsgId: job.id })
    },
    finish: async (status, ts) => {
      const result = await db.from('culture_posts').update({ status, slack_ts: ts || null, posted_at: status === 'posted' ? new Date().toISOString() : null,
        error: status === 'review' ? 'Slack acknowledgement is uncertain. Check the channel; do not repost automatically.' : status === 'failed' ? 'Preparation failed before sending. Kit can retry within the scheduled window.' : null,
        lease_until: new Date(Date.now() + 60000).toISOString() }).eq('id', job.id).eq('owner', owner).in('status', ['claimed', 'sending', 'review'])
      if (result.error) throw new Error('Culture acknowledgement could not be saved.')
    },
  })
}

export async function runCultureTick(app: App): Promise<number> {
  const config = await state(app)
  if (!config) return 0
  const db = cultureDb()
  const heartbeat = await db.from('culture_workspaces').update({ heartbeat_at: new Date().toISOString() }).eq('workspace_id', config.workspace_id)
  if (heartbeat.error) throw new Error('Culture heartbeat write failed.')
  if (!active(config)) return 0
  const recovery = await db.from('culture_posts').update({ status: 'review', error: 'Slack acknowledgement was not recorded. Review the channel before taking action.' }).eq('workspace_id', config.workspace_id).eq('status', 'sending').lt('lease_until', new Date().toISOString())
  if (recovery.error) throw new Error('Culture recovery checkpoint failed.')
  const deadline = Date.now() + 40000
  let posted = 0
  for (const item of await items(config)) {
    if (Date.now() >= deadline) break
    const key = dueKey(item, new Date(), isStudioHoliday)
    if (key && await postCultureItem(app, config, item, key)) posted++
  }
  return posted
}

export async function managedTimesheet(app: App): Promise<{ posted: boolean; template: string; image: boolean; reason?: string } | null> {
  const config = await state(app)
  if (!active(config)) return null
  let posted = false
  for (const item of (await items(config)).filter(row => row.kind === 'timesheet' && row.status === 'enabled')) {
    posted = await postCultureItem(app, config, item, localParts(new Date(), item.timezone).date) || posted
  }
  return { posted, template: 'Culture Center', image: false, reason: posted ? undefined : 'Paused or already posted; check Culture Center.' }
}
export async function managedDelivery(app: App, projectName: string): Promise<boolean | null> {
  const config = await state(app)
  if (!active(config)) return null
  let posted = false
  for (const item of (await items(config)).filter(row => row.kind === 'delivery' && row.status === 'enabled')) {
    posted = await postCultureItem(app, config, item, `${localParts(new Date(), item.timezone).date}:${digest(projectName)}`, projectName) || posted
  }
  return posted
}

/** Existing Slack commands share the same records after setup, not another schedule. */
export async function managedBirthday(app: App, personId: string, monthDay: string, name?: string, actor = 'slack'): Promise<boolean | null> {
  const config = await state(app)
  if (!config) return null
  const user = await app.client.users.info({ user: personId })
  if (!user.ok || !user.user || user.user.deleted || user.user.is_bot) throw new Error('Choose an active Slack teammate.')
  const existing = (await items(config)).find(item => item.kind === 'birthday' && item.person_id === personId)
  const item = existing || newMeme('birthday', config.default_channel_id, config.timezone, randomUUID())
  const personName = name || user.user.real_name || user.user.name || ''
  await saveMeme(config.workspace_id, actor, { ...item, name: `${personName}’s birthday`, person_id: personId, person_name: personName, month_day: monthDay, status: existing?.status === 'paused' ? 'paused' : 'enabled' }, true, `birthday:${personId}`)
  return active(config) ? true : null
}
export async function managedCelebration(app: App, label: string, fireDate: string | null, actor = 'slack'): Promise<boolean | null> {
  const config = await state(app)
  if (!config) return null
  const local = localParts(new Date(), config.timezone)
  const date = fireDate || local.date
  const legacy = `scheduled:${date}:${label}`
  const query = await cultureDb().from('culture_memes').select(MEME_FIELDS).eq('workspace_id', config.workspace_id).eq('legacy_key', legacy).maybeSingle()
  if (query.error) throw new Error('Celebration could not be loaded.')
  const prior = query.data ? memeSchema.parse(query.data) : null
  const item = prior || await saveMeme(config.workspace_id, actor, { ...newMeme('custom', config.default_channel_id, config.timezone, randomUUID()), name: label.slice(0, 100), briefing: label, fire_date: date, local_time: fireDate ? '09:00' : local.time, status: 'enabled' }, true, legacy)
  if (!active(config)) return null
  return fireDate ? true : postCultureItem(app, config, item, date)
}
