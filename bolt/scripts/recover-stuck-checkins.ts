// @ts-nocheck
/**
 * Recover stuck daily-hours check-ins WITHOUT re-nudging.
 *
 * A check-in stuck at status='sent'/'nudged' means Kit sent the DM but never
 * recorded a completed reply (reply_ts is null). If the person DID type their
 * hours — but Kit missed it (a socket drop, a mistimed DM they answered late,
 * an event that never reached the interceptor) — their message is still sitting
 * in the Slack DM history. This script reads that history with the BOT token,
 * finds their reply, and replays it through the exact same parse → resolve →
 * log pipeline the live interceptor uses (no duplicated domain logic), so the
 * hours land in Harvest on their original day without anyone re-typing.
 *
 * If a stuck check-in has no reply in its window, there is nothing to recover
 * and the script says so — that one genuinely needs a nudge.
 *
 * Run from the bolt/ directory:
 *   npx tsx scripts/recover-stuck-checkins.ts            # PREVIEW only (no writes)
 *   npx tsx scripts/recover-stuck-checkins.ts --commit   # replay + log to Harvest
 *
 * Optional filters:
 *   --since=YYYY-MM-DD   only check-ins on/after this date (default: 21 days ago)
 *   --user=U012345       only this Slack user id (repeatable)
 *
 * Required env (loaded via dotenv):
 *   SLACK_BOT_TOKEN
 *   HARVEST_ACCESS_TOKEN, HARVEST_ACCOUNT_ID   (only needed with --commit)
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { WebClient } from '@slack/web-api'
import { createAdminClient } from '../../src/lib/supabase/admin'
import {
  parseReplyWithLLM,
  resolveHarvestProject,
  handleCheckinReply,
} from '../src/checkins/reply'
import { handleCheckinConfirm } from '../src/checkins/confirm'

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}

const COMMIT = process.argv.includes('--commit')
const USERS = process.argv
  .filter((a) => a.startsWith('--user='))
  .map((a) => a.split('=')[1])

function defaultSince(): string {
  // 21 days back, computed off the process date; recovery only reaches recent
  // stuck rows (older ones are almost certainly abandoned, not un-processed).
  const d = new Date(Date.now() - 21 * 86_400_000)
  return d.toISOString().slice(0, 10)
}
const SINCE = arg('since') || defaultSince()

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN required')
  const client = new WebClient(process.env.SLACK_BOT_TOKEN)
  const app = { client } // the check-in pipeline only touches app.client
  const sb = createAdminClient()

  let q = sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, candidate_projects',
    )
    .in('status', ['sent', 'nudged'])
    .gte('check_in_date', SINCE)
    .not('dm_channel_id', 'is', null)
    .order('slack_user_id', { ascending: true })
    .order('dm_ts', { ascending: true })
  if (USERS.length) q = q.in('slack_user_id', USERS)

  const { data: rows, error } = await q
  if (error) throw new Error(`load stuck check-ins failed: ${error.message}`)
  if (!rows?.length) {
    console.log(`No stuck check-ins on/after ${SINCE}${USERS.length ? ` for ${USERS.join(', ')}` : ''}.`)
    return
  }

  console.log(
    `${COMMIT ? 'RECOVER (writing)' : 'PREVIEW (no writes)'} — ${rows.length} stuck check-in(s) on/after ${SINCE}\n`,
  )

  // Attribute each reply to the check-in it followed: search only the window
  // between this check-in's DM and the same user's NEXT check-in DM, so a reply
  // is never double-counted across two stuck days.
  const nextDmByUser = new Map<string, string[]>()
  for (const r of rows) {
    const list = nextDmByUser.get(r.slack_user_id) || []
    list.push(r.dm_ts)
    nextDmByUser.set(r.slack_user_id, list)
  }

  const summary = { recoverable: 0, logged: 0, noReply: 0, notHours: 0, errors: 0 }

  for (const open of rows) {
    const tag = `${open.slack_user_id} ${open.check_in_date}`
    const userTs = nextDmByUser.get(open.slack_user_id) || []
    const idx = userTs.indexOf(open.dm_ts)
    const latest = idx >= 0 && idx + 1 < userTs.length ? userTs[idx + 1] : undefined

    let reply: any
    try {
      const hist = await client.conversations.history({
        channel: open.dm_channel_id,
        oldest: open.dm_ts,
        ...(latest ? { latest } : {}),
        inclusive: false,
        limit: 100,
      })
      // history is newest-first; take the user's own messages in this window,
      // oldest-first, and join them (people sometimes split hours over lines).
      const mine = (hist.messages || [])
        .filter((m: any) => m.user === open.slack_user_id && !m.bot_id && !m.subtype && m.text)
        .reverse()
      if (mine.length) {
        reply = { text: mine.map((m: any) => m.text).join('\n'), ts: mine[0].ts }
      }
    } catch (err: any) {
      console.log(`  ✗ ${tag}: history read failed — ${err.data?.error || err.message}`)
      summary.errors++
      continue
    }

    if (!reply) {
      console.log(`  – ${tag}: no reply in DM — must re-nudge`)
      summary.noReply++
      continue
    }

    const preview = reply.text.replace(/\s+/g, ' ').slice(0, 70)

    if (!COMMIT) {
      // Pure preview: parse + resolve only, no DB write, no Harvest write.
      try {
        const parsed = await parseReplyWithLLM({
          replyText: reply.text,
          candidateProjects: open.candidate_projects || [],
          today: open.check_in_date,
        })
        if (parsed.skip) {
          console.log(`  ○ ${tag}: reply "${preview}" → would mark SKIPPED`)
          summary.notHours++
          continue
        }
        if (!parsed.entries.length) {
          console.log(`  ? ${tag}: reply "${preview}" → not an hours message — re-nudge`)
          summary.notHours++
          continue
        }
        const lines: string[] = []
        for (const e of parsed.entries) {
          const r = await resolveHarvestProject(e.projectQuery)
          const where =
            r.resolution === 'matched'
              ? r.project.name
              : `"${e.projectQuery}" (${r.resolution})`
          lines.push(`${e.hours}h → ${where}`)
        }
        console.log(`  ✓ ${tag}: reply "${preview}"\n      would log: ${lines.join('; ')}`)
        summary.recoverable++
      } catch (err: any) {
        console.log(`  ✗ ${tag}: parse failed — ${err.message}`)
        summary.errors++
      }
      continue
    }

    // --commit: replay through the real pipeline. handleCheckinReply claims the
    // 'sent'/'nudged' row, parses, resolves, stores parsed_entries, sets
    // 'parsed'. handleCheckinConfirm then logs to Harvest (its own CAS on
    // 'parsed' makes a skipped/non-hours reply a safe no-op).
    try {
      const handled = await handleCheckinReply({
        app,
        open,
        replyText: reply.text,
        replyTs: reply.ts,
      })
      if (!handled) {
        console.log(`  ? ${tag}: reply "${preview}" — not consumed (not hours) — re-nudge`)
        summary.notHours++
        continue
      }
      await handleCheckinConfirm({ app, client, body: {}, checkinId: open.id })
      // Re-read to report the outcome the confirm handler landed on.
      const { data: after } = await sb
        .from('daily_hours_checkins')
        .select('status, harvest_entry_ids, error_message')
        .eq('id', open.id)
        .maybeSingle()
      if (after?.status === 'logged') {
        console.log(`  ✓ ${tag}: logged Harvest #${(after.harvest_entry_ids || []).join(', ')}`)
        summary.logged++
      } else if (after?.status === 'skipped') {
        console.log(`  ○ ${tag}: marked skipped`)
        summary.notHours++
      } else {
        console.log(`  ! ${tag}: status=${after?.status} ${after?.error_message || ''}`)
        summary.errors++
      }
    } catch (err: any) {
      console.log(`  ✗ ${tag}: recover failed — ${err.message}`)
      summary.errors++
    }
  }

  console.log(
    `\nDone. ${
      COMMIT
        ? `logged=${summary.logged} skipped/not-hours=${summary.notHours} no-reply=${summary.noReply} errors=${summary.errors}`
        : `recoverable=${summary.recoverable} not-hours=${summary.notHours} no-reply=${summary.noReply} errors=${summary.errors}`
    }`,
  )
  if (!COMMIT && summary.recoverable > 0) {
    console.log('Re-run with --commit to replay these into Harvest.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
