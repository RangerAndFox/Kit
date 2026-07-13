// @ts-nocheck
/**
 * Celebration memes — birthdays, project deliveries, holidays, ad-hoc, and
 * scheduled occasions, all posted to the full-team channel via the shared
 * meme engine. Pure parsing/matching helpers are exported for tests; the
 * DB + post functions are thin wrappers around them.
 *
 * Config: KIT_TEAM_CHANNEL_ID (where memes land). Degrades to text memes
 * without IMGFLIP creds; no-ops (logs) without the channel.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { postMeme } from '../memes/meme-engine'
import { checkinToday, isStudioHoliday } from '../checkins/date'

const teamChannel = () => process.env.KIT_TEAM_CHANNEL_ID || ''

// ─── Pure helpers (unit-tested) ────────────────────────────────

/** 'YYYY-MM-DD' → 'MM-DD'. */
export function monthDay(ymd: string): string {
  return ymd.slice(5, 10)
}

/** Parse a user-typed birthday ('3-14', '03/14', '3/4') → 'MM-DD', or null. */
export function parseBirthday(input: string): string | null {
  const m = String(input || '').trim().match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (!m) return null
  const mm = Number(m[1])
  const dd = Number(m[2])
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

/** Does a stored 'MM-DD' birthday fall on `todayMd` ('MM-DD')? */
export function birthdayIsToday(birthday: string | null | undefined, todayMd: string): boolean {
  return !!birthday && parseBirthday(birthday.replace('-', '-')) === todayMd
}

/**
 * Parse `/kit celebrate` args. A leading date token (MM-DD or MM/DD) schedules
 * the occasion for its next occurrence; otherwise it's an ad-hoc "now" post.
 * Returns { fireDate: 'YYYY-MM-DD' | null, label }.
 */
export function parseCelebrateArgs(text: string, today: string = checkinToday()): { fireDate: string | null; label: string } {
  const trimmed = String(text || '').trim()
  const m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})\s+(.*)$/)
  if (m) {
    const mm = Number(m[1])
    const dd = Number(m[2])
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return { fireDate: nextOccurrence(mm, dd, today), label: m[3].trim() }
    }
  }
  return { fireDate: null, label: trimmed }
}

/** The next YYYY-MM-DD on/after `today` for a given month/day. Pure. */
export function nextOccurrence(mm: number, dd: number, today: string): string {
  const year = Number(today.slice(0, 4))
  const mmdd = `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  const thisYear = `${year}-${mmdd}`
  return thisYear >= today ? thisYear : `${year + 1}-${mmdd}`
}

// ─── DB + post ─────────────────────────────────────────────────

/** Set/replace a team member's birthday. Any Slack user — not staff-gated. */
export async function setBirthday(slackUserId: string, mmdd: string, fullName?: string, createdBy?: string): Promise<boolean> {
  const { error } = await createAdminClient()
    .from('birthdays')
    .upsert(
      { slack_user_id: slackUserId, month_day: mmdd, full_name: fullName || null, created_by: createdBy || null },
      { onConflict: 'slack_user_id' },
    )
  if (error) { console.warn(`[celebrations] setBirthday: ${error.message}`); return false }
  return true
}

/** Post a birthday meme for each team member whose birthday is today. */
export async function postBirthdayMemes(app: App): Promise<number> {
  const channel = teamChannel()
  if (!channel) return 0
  const todayMd = monthDay(checkinToday())
  const { data } = await createAdminClient()
    .from('birthdays')
    .select('slack_user_id, full_name, month_day')
  let posted = 0
  for (const b of data || []) {
    if (!birthdayIsToday(b.month_day, todayMd)) continue
    const who = b.slack_user_id ? `<@${b.slack_user_id}>` : b.full_name || 'a teammate'
    await postMeme(app, {
      channel,
      headline: `:birthday: *Happy birthday, ${who}!*`,
      briefing: `It's ${b.full_name || 'a teammate'}'s birthday today at the studio.`,
      altText: 'birthday meme',
    }).catch((e) => console.warn(`[celebrations] birthday post failed: ${e?.message || e}`))
    posted++
  }
  return posted
}

/** Post a holiday meme once if today is a studio holiday. */
export async function postHolidayMeme(app: App): Promise<boolean> {
  const channel = teamChannel()
  if (!channel) return false
  const today = checkinToday()
  if (!isStudioHoliday(today)) return false
  if (!(await claimOnce('holiday', today, today))) return false
  await postMeme(app, {
    channel,
    headline: ':tada: *Studio holiday!*',
    briefing: `Today is a US public holiday and the studio is closed — the team has the day off.`,
    altText: 'holiday meme',
  }).catch((e) => console.warn(`[celebrations] holiday post failed: ${e?.message || e}`))
  return true
}

/** Fire any scheduled occasions due today (one-shot). */
export async function postScheduledCelebrations(app: App): Promise<number> {
  const channel = teamChannel()
  if (!channel) return 0
  const today = checkinToday()
  const sb = createAdminClient()
  const { data } = await sb
    .from('celebrations')
    .select('id, label')
    .eq('kind', 'scheduled')
    .eq('fire_date', today)
    .is('posted_at', null)
  let posted = 0
  for (const row of data || []) {
    await postMeme(app, {
      channel,
      headline: `:confetti_ball: *${row.label}*`,
      briefing: row.label,
      altText: 'celebration meme',
    }).catch((e) => console.warn(`[celebrations] scheduled post failed: ${e?.message || e}`))
    await sb.from('celebrations').update({ posted_at: new Date().toISOString() }).eq('id', row.id)
    posted++
  }
  return posted
}

/** Ad-hoc: post a meme for `label` right now. */
export async function celebrateNow(app: App, label: string): Promise<boolean> {
  const channel = teamChannel()
  if (!channel || !label) return false
  await postMeme(app, {
    channel,
    headline: `:confetti_ball: *${label}*`,
    briefing: label,
    altText: 'celebration meme',
  })
  return true
}

/** Schedule an occasion for a future date. */
export async function scheduleCelebration(label: string, fireDate: string, createdBy?: string): Promise<void> {
  await createAdminClient()
    .from('celebrations')
    .upsert({ kind: 'scheduled', label, fire_date: fireDate, created_by: createdBy || null },
            { onConflict: 'kind,label,fire_date', ignoreDuplicates: true })
}

/**
 * Delivery celebration — called when a file lands in a project's delivery
 * folder. Deduped to one meme per project per day via the unique index: the
 * insert is the claim; only the first drop of the day posts.
 */
export async function postDeliveryCelebration(app: App, projectName: string): Promise<boolean> {
  const channel = teamChannel()
  if (!channel || !projectName) return false
  const today = checkinToday()
  if (!(await claimOnce('delivery', projectName, today))) return false
  await postMeme(app, {
    channel,
    headline: `:rocket: *We shipped it — ${projectName} delivered!*`,
    briefing: `The team just delivered the "${projectName}" project to the client.`,
    altText: 'delivery celebration meme',
  }).catch((e) => console.warn(`[celebrations] delivery post failed: ${e?.message || e}`))
  return true
}

/** Daily runner (cron): birthdays + holiday + scheduled. */
export async function runDailyCelebrations(app: App): Promise<{ birthdays: number; holiday: boolean; scheduled: number }> {
  const birthdays = await postBirthdayMemes(app).catch(() => 0)
  const holiday = await postHolidayMeme(app).catch(() => false)
  const scheduled = await postScheduledCelebrations(app).catch(() => 0)
  return { birthdays, holiday, scheduled }
}

/**
 * Atomic "first time today?" claim via the unique (kind,label,fire_date)
 * index. Returns true only for the insert that actually created the row.
 */
async function claimOnce(kind: string, label: string, fireDate: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('celebrations')
    .upsert({ kind, label, fire_date: fireDate, posted_at: new Date().toISOString() },
            { onConflict: 'kind,label,fire_date', ignoreDuplicates: true })
    .select('id')
  if (error) { console.warn(`[celebrations] claimOnce(${kind},${label}): ${error.message}`); return false }
  return !!(data && data.length)
}
