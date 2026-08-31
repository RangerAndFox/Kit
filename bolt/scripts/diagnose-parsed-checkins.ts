/**
 * Diagnose WHY daily-hours check-ins get stuck at status='parsed'.
 *
 * A 'parsed' row means the person replied, Kit parsed their hours and posted
 * the confirmation card — but the check-in never advanced to 'logged'. This
 * tells us which of three things happened, per person, WITHOUT writing anything
 * or touching Harvest:
 *
 *   confirmed-not-processed : they DID type a confirm ("yes"/"confirm"/…) after
 *                             the card, but it never logged — a delivery/handler
 *                             gap, the most serious case.
 *   unrecognised-reply      : they replied affirmatively in words the strict
 *                             confirm matcher rejects (e.g. "yep that's right,
 *                             thanks") — the fixable phrasing gap. Their text is
 *                             printed so we can broaden the matcher.
 *   redo-not-processed      : they typed a redo that never took.
 *   no-response             : they never answered the confirmation card.
 *
 * It reuses the LIVE confirm matcher (parseConfirmDecision) — no duplicated
 * logic — so "would this have been recognised?" is judged exactly as the bot
 * judges it in production.
 *
 * READ-ONLY: reads Slack DM history + Supabase, writes nothing.
 *
 * Run from the bolt/ directory:
 *   npx tsx scripts/diagnose-parsed-checkins.ts
 *   npx tsx scripts/diagnose-parsed-checkins.ts --since=2026-07-01 --user=U4CA7HXT9
 *
 * Required env (loaded via dotenv):
 *   SLACK_BOT_TOKEN
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { WebClient } from '@slack/web-api'
import { createAdminClient } from '../../src/lib/supabase/admin'
import { parseConfirmDecision } from '../src/checkins/reply'

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}

const USERS = process.argv.filter((a) => a.startsWith('--user=')).map((a) => a.split('=')[1])

function defaultSince(): string {
  const d = new Date(Date.now() - 30 * 86_400_000)
  return d.toISOString().slice(0, 10)
}
const SINCE = arg('since') || defaultSince()

const trunc = (s: string, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// A confirmation follows the card within a day or two; bound open-ended windows
// to this so the fetch stays small and can't truncate the real confirm.
const WINDOW_SECS = 3 * 86_400

/**
 * The target user's own text messages in (oldest, latest), oldest-first.
 * Paginates on has_more so a busy DM (the check-in channel is shared with
 * general assistant chatter) can't drop an early confirm off the first page.
 */
async function userMessagesInWindow(
  client: WebClient,
  channel: string,
  oldest: string,
  latest: string,
  userId: string,
): Promise<any[]> {
  const out: any[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const hist = await client.conversations.history(
      cursor
        ? { channel, cursor, limit: 200 }
        : { channel, oldest, latest, inclusive: false, limit: 200 },
    )
    for (const m of hist.messages || []) {
      if (m.user === userId && !m.bot_id && !m.subtype && m.text) out.push(m)
    }
    if (!hist.has_more || !hist.response_metadata?.next_cursor) break
    cursor = hist.response_metadata.next_cursor
  }
  // history returns newest-first across pages; hand back oldest-first.
  return out.reverse()
}

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN required')
  const client = new WebClient(process.env.SLACK_BOT_TOKEN)
  const sb = createAdminClient()

  // The stuck rows we're explaining.
  let stuckQ = sb
    .from('daily_hours_checkins')
    .select('id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, reply_ts')
    .eq('status', 'parsed')
    .gte('check_in_date', SINCE)
    .not('dm_channel_id', 'is', null)
    .order('slack_user_id', { ascending: true })
    .order('check_in_date', { ascending: true })
  if (USERS.length) stuckQ = stuckQ.in('slack_user_id', USERS)
  const { data: stuck, error } = await stuckQ
  if (error) throw new Error(`load parsed check-ins failed: ${error.message}`)
  if (!stuck?.length) {
    console.log(`No parsed (stuck) check-ins on/after ${SINCE}${USERS.length ? ` for ${USERS.join(', ')}` : ''}.`)
    return
  }

  // Per-user DM timeline (ALL statuses) so each row's window ends at that
  // person's NEXT check-in DM — a confirmation typed the next day for the next
  // check-in is never miscredited to this one.
  // Must cover at least as far back as the stuck rows (SINCE), not a fixed 30d —
  // otherwise a stuck row older than 30d loses its next-DM boundary and the
  // history window can sweep in a later, unrelated check-in's reply.
  const { data: allRows } = await sb
    .from('daily_hours_checkins')
    .select('slack_user_id, dm_ts')
    .gte('check_in_date', SINCE)
    .not('dm_ts', 'is', null)
  const dmTimeline = new Map<string, number[]>()
  for (const r of allRows || []) {
    const list = dmTimeline.get(r.slack_user_id) || []
    list.push(Number(r.dm_ts))
    dmTimeline.set(r.slack_user_id, list)
  }
  for (const list of dmTimeline.values()) list.sort((a, b) => a - b)

  const nextDmAfter = (user: string, ts: number): string | undefined => {
    const list = dmTimeline.get(user) || []
    const next = list.find((t) => t > ts + 1e-6)
    return next ? String(next) : undefined
  }

  console.log(`PARSED-STUCK DIAGNOSIS (read-only) — ${stuck.length} check-in(s) on/after ${SINCE}\n`)

  const summary = { confirmed: 0, unrecognised: 0, redo: 0, noResponse: 0, errors: 0 }
  const unrecognisedTexts: string[] = []
  const perUser = new Map<string, { confirmed: number; unrecognised: number; redo: number; noResponse: number }>()
  const bump = (user: string, k: string) => {
    const u = perUser.get(user) || { confirmed: 0, unrecognised: 0, redo: 0, noResponse: 0 }
    u[k]++
    perUser.set(user, u)
  }

  for (const row of stuck) {
    const tag = `${row.slack_user_id} ${row.check_in_date}`
    // Look strictly AFTER their hours reply (their confirmation would follow it);
    // fall back to the card/DM ts if reply_ts is somehow missing.
    const oldest = row.reply_ts || row.dm_ts
    const oldestNum = Number(oldest)
    // Bound the window's upper end: the next check-in DM if there is one, else a
    // few days after the reply. Never leave it open-ended to "now" — that both
    // sweeps in later unrelated activity AND lets Slack's newest-first paging
    // silently truncate an old confirm (typed right after the reply) out of the
    // first page. A confirmation lands within a day or two of the card.
    const nextDm = nextDmAfter(row.slack_user_id, oldestNum)
    const latest = String(Math.min(nextDm ? Number(nextDm) : Infinity, oldestNum + WINDOW_SECS))

    let msgs: any[]
    try {
      msgs = await userMessagesInWindow(client, row.dm_channel_id, oldest, latest, row.slack_user_id)
    } catch (err: any) {
      console.log(`  ✗ ${tag}: history read failed — ${err.data?.error || err.message}`)
      summary.errors++
      continue
    }

    if (msgs.length === 0) {
      console.log(`  – ${tag}: no response to the confirmation card`)
      summary.noResponse++
      bump(row.slack_user_id, 'noResponse')
      continue
    }

    const decisions = msgs.map((m) => ({ text: m.text as string, d: parseConfirmDecision(m.text) }))
    const confirmed = decisions.find((x) => x.d === 'confirm')
    const redo = decisions.find((x) => x.d === 'redo')

    if (confirmed) {
      console.log(`  ‼ ${tag}: CONFIRMED but never logged — typed "${trunc(confirmed.text)}"`)
      summary.confirmed++
      bump(row.slack_user_id, 'confirmed')
    } else if (redo) {
      console.log(`  ↻ ${tag}: typed redo ("${trunc(redo.text)}") but row still parsed`)
      summary.redo++
      bump(row.slack_user_id, 'redo')
    } else {
      const texts = decisions.map((x) => `"${trunc(x.text, 60)}"`).join(' | ')
      console.log(`  ? ${tag}: replied, NOT recognised as confirm — ${texts}`)
      summary.unrecognised++
      bump(row.slack_user_id, 'unrecognised')
      for (const x of decisions) unrecognisedTexts.push(trunc(x.text, 60))
    }
  }

  console.log(
    `\nSummary: confirmed-not-logged=${summary.confirmed}  unrecognised-reply=${summary.unrecognised}  ` +
      `redo-not-processed=${summary.redo}  no-response=${summary.noResponse}  errors=${summary.errors}`,
  )
  console.log('\nBy person:')
  for (const [user, u] of perUser) {
    console.log(
      `  ${user}: confirmed=${u.confirmed} unrecognised=${u.unrecognised} redo=${u.redo} no-response=${u.noResponse}`,
    )
  }
  if (unrecognisedTexts.length) {
    console.log('\nUnrecognised affirmative replies (candidates for broadening the confirm matcher):')
    for (const t of unrecognisedTexts) console.log(`  • "${t}"`)
  }
  if (summary.confirmed > 0) {
    console.log(
      `\n‼ ${summary.confirmed} check-in(s) were CONFIRMED in-chat but never logged — a delivery/handler gap, not phrasing.`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
