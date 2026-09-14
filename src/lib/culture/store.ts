import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../supabase/admin'
import { studioHolidays } from './holidays'
import { memeSchema, newMeme, nextMidnight, validMonthDay, publicSafeText, type Meme, type CultureData, type CultureWorkspace } from './model'

export const cultureDb = (): SupabaseClient => createAdminClient() as SupabaseClient
export const MEME_FIELDS = 'id,revision,kind,name,briefing,channel_id,template_id,status,schedule,month_day,weekday,fire_date,local_time,timezone,person_id,person_name'
export async function workspaceForTeam(teamId: string): Promise<string> {
  if (!/^T[A-Z0-9]{8,}$/.test(teamId)) throw new Error('Slack workspace could not be verified.')
  const { data, error } = await cultureDb().from('workspaces').select('id').eq('slack_team_id', teamId).single()
  if (error || !data) throw new Error('Slack workspace could not be verified.')
  return data.id
}
export async function cultureWorkspace(workspaceId: string): Promise<CultureWorkspace | null> {
  const { data, error } = await cultureDb().from('culture_workspaces').select('workspace_id,starts_at,default_channel_id,timezone,heartbeat_at').eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error('Culture Center database is not ready.')
  return data
}

type SlackResult = { ok?: boolean; team_id?: string; channels?: Array<{ id: string; name: string; is_archived?: boolean; is_member?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean }>; channel?: { id: string; name: string; is_archived?: boolean; is_member?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean }; response_metadata?: { next_cursor?: string } }
async function slack(method: string, values: Record<string, string> = {}): Promise<SlackResult> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('Slack connection is unavailable.')
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values), signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store',
  })
  if (!response.ok) throw new Error('Slack connection is unavailable.')
  const result = await response.json() as SlackResult
  if (!result.ok) throw new Error('Slack connection is unavailable.')
  return result
}
export async function verifySlackWorkspace(workspaceId: string): Promise<void> {
  const result = await slack('auth.test')
  if (await workspaceForTeam(result.team_id || '') !== workspaceId) throw new Error('Slack workspace does not match.')
}
export async function verifyDestination(workspaceId: string, channelId: string): Promise<void> {
  await verifySlackWorkspace(workspaceId)
  const { channel } = await slack('conversations.info', { channel: channelId })
  if (!channel || !channel.is_member || channel.is_archived || channel.is_ext_shared || channel.is_org_shared) throw new Error('Choose an internal, active channel that Kit has joined.')
}
export async function cultureChannels(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  await verifySlackWorkspace(workspaceId)
  const channels: Array<{ id: string; name: string }> = []
  let cursor = ''
  for (let page = 0; page < 10; page++) {
    const result = await slack('conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', cursor })
    channels.push(...(result.channels || []).filter(c => c.is_member && !c.is_archived && !c.is_ext_shared && !c.is_org_shared).map(c => ({ id: c.id, name: c.name })))
    cursor = result.response_metadata?.next_cursor || ''
    if (!cursor) return channels.sort((a, b) => a.name.localeCompare(b.name))
  }
  throw new Error('Slack channel list is too large; narrow Kit’s channel membership.')
}
export async function loadCultureData(workspaceId: string): Promise<CultureData> {
  const db = cultureDb()
  const [workspace, memes, posts, people, channels] = await Promise.all([
    cultureWorkspace(workspaceId),
    db.from('culture_memes').select(MEME_FIELDS).eq('workspace_id', workspaceId).order('created_at').limit(500),
    db.from('culture_posts').select('id,meme_id,name,occurrence_key,channel_id,status,created_at,posted_at,slack_ts,error').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100),
    db.from('team_members').select('slack_user_id,name').eq('workspace_id', workspaceId).not('slack_user_id', 'is', null).limit(1000),
    cultureChannels(workspaceId).then(value => ({ value, error: null })).catch(() => ({ value: [], error: 'Channel verification is unavailable. Changes are disabled until Slack reconnects.' })),
  ])
  if (memes.error || posts.error || people.error) throw new Error('Culture Center could not load its saved records.')
  const saved = (memes.data || []).map(row => memeSchema.parse(row))
  // Preserve imported Slack people not yet in the local People table; never expose emails.
  const choices = new Map<string, string>((people.data || []).filter(p => p.slack_user_id && p.name).map(p => [p.slack_user_id, p.name]))
  for (const meme of saved) if (meme.person_id && meme.person_name && !choices.has(meme.person_id)) choices.set(meme.person_id, meme.person_name)
  const year = new Date().getUTCFullYear()
  const holidays = [...studioHolidays(year), ...studioHolidays(year + 1), ...(process.env.STUDIO_HOLIDAYS || '').split(',').map(value => value.trim()).filter(Boolean)]
  return { workspace, memes: saved, posts: posts.data || [], people: [...choices].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), channels: channels.value, generatedAt: new Date().toISOString(), warning: channels.error, holidays }
}

export async function saveMeme(workspaceId: string, actor: string, input: unknown, confirmed: boolean, legacyKey?: string): Promise<Meme> {
  const item = memeSchema.parse(input)
  if (item.status === 'enabled' && !confirmed) throw new Error('Review the destination, schedule and public-safe wording before enabling.')
  if (!legacyKey && item.revision === 0 && item.status !== 'draft') throw new Error('Save new memes as drafts first.')
  await verifyDestination(workspaceId, item.channel_id)
  if (item.person_id) {
    const db = cultureDb()
    const { data, error } = await db.from('team_members').select('slack_user_id').eq('workspace_id', workspaceId).eq('slack_user_id', item.person_id).maybeSingle()
    if (error) throw new Error('Employee could not be verified.')
    if (!data && legacyKey !== `birthday:${item.person_id}`) {
      const existing = await db.from('culture_memes').select('id').eq('workspace_id', workspaceId).eq('person_id', item.person_id).eq('id', item.id).maybeSingle()
      if (existing.error || !existing.data) throw new Error('Choose an employee from this workspace’s People list.')
    }
  }
  const { data, error } = await cultureDb().rpc('save_culture_meme', { p_workspace: workspaceId, p_actor: actor, p_item: item, p_confirm: confirmed, p_legacy_key: legacyKey || null })
  if (error || !data) throw new Error('Could not save: refresh for recent changes, check for an existing birthday, or wait for an in-flight post to finish.')
  return memeSchema.parse(Object.fromEntries(MEME_FIELDS.split(',').map(key => [key, data[key]])))
}

/** Explicit setup, after verified admin + Slack-team binding. Import never occurs on a GET. */
export async function initializeCulture(workspaceId: string, actor: string, channel: string, timezone: string): Promise<void> {
  await verifyDestination(workspaceId, channel)
  const db = cultureDb()
  const [workspaces, birthdays, scheduled] = await Promise.all([
    db.from('workspaces').select('id', { count: 'exact', head: true }),
    db.from('birthdays').select('slack_user_id,full_name,month_day').limit(500),
    db.from('celebrations').select('id,label,fire_date').eq('kind', 'scheduled').is('posted_at', null).limit(500),
  ])
  if (workspaces.error || workspaces.count !== 1 || birthdays.error || scheduled.error) throw new Error('Legacy records cannot be safely mapped to one studio.')
  const seeds: Array<Meme & { legacy_key: string }> = []
  for (const kind of ['timesheet', 'holiday', 'delivery'] as const) seeds.push({ ...newMeme(kind, channel, timezone, randomUUID()), status: 'enabled', legacy_key: kind })
  for (const b of birthdays.data || []) {
    if (!validMonthDay(b.month_day) || !b.full_name || !publicSafeText(b.full_name)) throw new Error('A legacy birthday needs a valid name and date before importing.')
    seeds.push({ ...newMeme('birthday', channel, timezone, randomUUID()), name: `${b.full_name}’s birthday`, person_id: b.slack_user_id, person_name: b.full_name, month_day: b.month_day, status: 'enabled', legacy_key: `birthday:${b.slack_user_id}` })
  }
  for (const row of scheduled.data || []) {
    const legacyKey = `scheduled:${row.fire_date}:${row.label}`
    if (!seeds.some(item => item.legacy_key === legacyKey)) seeds.push({ ...newMeme('custom', channel, timezone, randomUUID()), name: row.label.slice(0, 100), briefing: row.label, fire_date: row.fire_date, status: 'draft', legacy_key: legacyKey })
  }
  for (const item of seeds) memeSchema.parse(Object.fromEntries(MEME_FIELDS.split(',').map(key => [key, item[key as keyof Meme]])))
  const { error } = await db.rpc('initialize_culture', { p_workspace: workspaceId, p_actor: actor, p_channel: channel, p_timezone: timezone, p_starts_at: nextMidnight(new Date(), timezone), p_items: seeds })
  if (error) throw new Error('Culture Center setup was not saved. No schedules were changed.')
}
