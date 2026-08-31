/**
 * Recover stuck daily-hours check-ins WITHOUT re-nudging.
 *
 * A check-in stuck at status='sent'/'nudged' means Kit sent the DM but never
 * recorded a completed reply. If the person DID type their hours, the message
 * is still in the Slack DM history: this reads it, resolves the projects, and
 * logs the hours to Harvest on the original day.
 *
 * ── Preview is a contract ──────────────────────────────────────────────────
 * The preview writes a PLAN file of exactly-resolved entries, and --commit
 * logs that plan verbatim. It does NOT re-parse. An earlier version re-ran the
 * LLM at commit time, so what got written was never what was reviewed — a
 * non-deterministic re-parse of an over-captured message span wrote ~25h and
 * ~15h days into Harvest. Now: what you review is what is written, or nothing.
 *
 * Three independent safeguards, none relied on alone:
 *   1. Commit logs the reviewed plan (no LLM at commit time).
 *   2. The plan is re-validated before writing (all projects resolved, day
 *      total within a sane cap, no duplicate entries) — see src/checkins/recovery.ts.
 *   3. --commit targets exactly one --user and one --date, and refuses a plan
 *      whose check-in is no longer stuck (so it can't double-log).
 *
 * Run from the bolt/ directory:
 *   # 1. Survey + write the plan (no writes to Harvest/Supabase):
 *   npx tsx scripts/recover-stuck-checkins.ts
 *   # 2. Review one day, then log exactly that:
 *   npx tsx scripts/recover-stuck-checkins.ts --user=U012345 --date=2026-08-10
 *   npx tsx scripts/recover-stuck-checkins.ts --user=U012345 --date=2026-08-10 --commit
 *
 * Options:
 *   --since=YYYY-MM-DD    preview check-ins on/after this date (default: 21d ago)
 *   --user=U012345        restrict to this Slack user (required for --commit)
 *   --date=YYYY-MM-DD     restrict to this check-in day (required for --commit)
 *   --plan=<path>         plan file location (default: /tmp/kit-recovery-plan.json)
 *   --max-hours=N         single-day total that fails validation (default: 16)
 *   --allow-duplicates    permit repeated (project, hours) entries
 *
 * Required env (loaded via dotenv):
 *   SLACK_BOT_TOKEN
 *   ANTHROPIC_API_KEY                          (preview only — parses replies)
 *   HARVEST_ACCESS_TOKEN, HARVEST_ACCOUNT_ID
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { WebClient } from '@slack/web-api'
import { createAdminClient } from '../../src/lib/supabase/admin'
import { parseReplyWithLLM, resolveHarvestProject } from '../src/checkins/reply'
import { handleCheckinConfirm } from '../src/checkins/confirm'
import {
  extractReplyBurst,
  validateEntries,
  DEFAULT_MAX_TOTAL_HOURS,
} from '../src/checkins/recovery'

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : undefined
}

const COMMIT = process.argv.includes('--commit')
const ALLOW_DUPLICATES = process.argv.includes('--allow-duplicates')
const USERS = process.argv.filter((a) => a.startsWith('--user=')).map((a) => a.split('=')[1])
const DATE = arg('date')
const PLAN_PATH = arg('plan') || '/tmp/kit-recovery-plan.json'
const MAX_HOURS = Number(arg('max-hours') || DEFAULT_MAX_TOTAL_HOURS)

function defaultSince(): string {
  const d = new Date(Date.now() - 21 * 86_400_000)
  return d.toISOString().slice(0, 10)
}
const SINCE = arg('since') || defaultSince()

/** Load stuck check-ins, optionally narrowed to one user and/or one day. */
async function loadStuck(sb: any) {
  let q = sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, candidate_projects',
    )
    .in('status', ['sent', 'nudged'])
    .not('dm_channel_id', 'is', null)
    .order('slack_user_id', { ascending: true })
    .order('dm_ts', { ascending: true })
  q = DATE ? q.eq('check_in_date', DATE) : q.gte('check_in_date', SINCE)
  if (USERS.length) q = q.in('slack_user_id', USERS)
  const { data, error } = await q
  if (error) throw new Error(`load stuck check-ins failed: ${error.message}`)
  return data || []
}

/**
 * Find the person's reply to one check-in. The SEARCH window is wide (up to
 * their next check-in DM) because replies often arrive a day or more later;
 * only the first contiguous burst inside it is taken as the answer.
 */
async function findReply(client: any, open: any, nextDmTs: string | undefined) {
  const hist = await client.conversations.history({
    channel: open.dm_channel_id,
    oldest: open.dm_ts,
    ...(nextDmTs ? { latest: nextDmTs } : {}),
    inclusive: false,
    limit: 200,
  })
  return extractReplyBurst(hist.messages || [], open.slack_user_id)
}

async function runPreview(sb: any, client: any, rows: any[]) {
  const scope = DATE ? `on ${DATE}` : `on/after ${SINCE}`
  console.log(`PREVIEW (no writes) — ${rows.length} stuck check-in(s) ${scope}\n`)

  // Window boundary: the user's next check-in DM of ANY status.
  const users = Array.from(new Set(rows.map((r: any) => r.slack_user_id)))
  const { data: allCheckins } = await sb
    .from('daily_hours_checkins')
    .select('slack_user_id, dm_ts')
    .in('slack_user_id', users)
    .not('dm_ts', 'is', null)
  const dmsByUser = new Map<string, number[]>()
  for (const c of allCheckins || []) {
    const list = dmsByUser.get(c.slack_user_id) || []
    list.push(Number(c.dm_ts))
    dmsByUser.set(c.slack_user_id, list)
  }
  for (const l of dmsByUser.values()) l.sort((a, b) => a - b)

  const plan: any[] = []
  const tally = { plannable: 0, blocked: 0, notHours: 0, noReply: 0, errors: 0 }

  for (const open of rows) {
    const tag = `${open.slack_user_id} ${open.check_in_date}`
    const nextTs = (dmsByUser.get(open.slack_user_id) || []).find((t) => t > Number(open.dm_ts))

    let burst: any
    try {
      burst = await findReply(client, open, nextTs != null ? nextTs.toFixed(6) : undefined)
    } catch (err: any) {
      console.log(`  ✗ ${tag}: history read failed — ${err.data?.error || err.message}`)
      tally.errors++
      continue
    }
    if (!burst) {
      console.log(`  – ${tag}: no reply in DM — must re-nudge`)
      tally.noReply++
      continue
    }

    const preview = burst.text.replace(/\s+/g, ' ').slice(0, 70)
    const extra = burst.excludedCount
      ? ` [${burst.excludedCount} later msg(s) excluded]`
      : ''

    let parsed: any
    try {
      parsed = await parseReplyWithLLM({
        replyText: burst.text,
        candidateProjects: open.candidate_projects || [],
        today: open.check_in_date,
      })
    } catch (err: any) {
      console.log(`  ✗ ${tag}: parse failed — ${err.message}`)
      tally.errors++
      continue
    }

    if (parsed.skip || !parsed.entries.length) {
      console.log(`  ○ ${tag}: reply "${preview}"${extra} → not hours (would skip)`)
      tally.notHours++
      continue
    }

    const entries: any[] = []
    for (const e of parsed.entries) {
      const r = await resolveHarvestProject(e.projectQuery)
      entries.push({
        hours: Number(e.hours),
        spentDate: open.check_in_date,
        notes: e.notes || undefined,
        projectQuery: e.projectQuery,
        resolution: r.resolution,
        harvest_project_id: r.project?.id,
        harvest_project_name: r.project?.name,
      })
    }

    const v = validateEntries(entries, {
      maxTotalHours: MAX_HOURS,
      allowDuplicates: ALLOW_DUPLICATES,
    })
    const lines = entries
      .map(
        (e) =>
          `${e.hours}h → ${
            e.resolution === 'matched' ? e.harvest_project_name : `"${e.projectQuery}" (${e.resolution})`
          }`,
      )
      .join('; ')

    if (!v.ok) {
      console.log(`  ⚠ ${tag}: reply "${preview}"${extra}`)
      console.log(`      parsed (${v.totalHours}h): ${lines}`)
      console.log(`      NOT PLANNED — ${v.problems.join('; ')}`)
      console.log(`      → have them enter this day in Harvest directly`)
      tally.blocked++
      continue
    }

    console.log(`  ✓ ${tag}: reply "${preview}"${extra}`)
    console.log(`      would log (${v.totalHours}h): ${lines}`)
    plan.push({
      checkinId: open.id,
      slackUserId: open.slack_user_id,
      checkInDate: open.check_in_date,
      replyTs: burst.ts,
      totalHours: v.totalHours,
      entries,
    })
    tally.plannable++
  }

  writeFileSync(PLAN_PATH, JSON.stringify({ createdFor: scope, plan }, null, 2))
  console.log(
    `\nDone. plannable=${tally.plannable} blocked=${tally.blocked} not-hours=${tally.notHours} ` +
      `no-reply=${tally.noReply} errors=${tally.errors}`,
  )
  console.log(`Plan written to ${PLAN_PATH}`)
  if (tally.plannable > 0) {
    console.log(
      'To log ONE reviewed check-in exactly as shown above:\n' +
        '  --user=<slackId> --date=YYYY-MM-DD --commit',
    )
  }
}

/**
 * Log one reviewed check-in. Writes the PLANNED entries to the row and calls
 * the production confirm handler, which logs `parsed_entries` verbatim — the
 * LLM is never invoked here, so the write cannot differ from the review.
 */
async function runCommit(sb: any, client: any, rows: any[]) {
  const app = { client }

  if (rows.length !== 1) {
    throw new Error(
      `--commit expects exactly one stuck check-in for ${USERS[0]} on ${DATE}, found ${rows.length}. ` +
        'It may already be logged — re-run the preview.',
    )
  }
  const open = rows[0]

  let file: any
  try {
    file = JSON.parse(readFileSync(PLAN_PATH, 'utf8'))
  } catch (err: any) {
    throw new Error(`could not read plan at ${PLAN_PATH} (${err.message}). Run the preview first.`)
  }
  const planned = (file.plan || []).find(
    (p: any) => p.checkinId === open.id && p.slackUserId === USERS[0] && p.checkInDate === DATE,
  )
  if (!planned) {
    throw new Error(
      `no reviewed plan for ${USERS[0]} on ${DATE} in ${PLAN_PATH}. ` +
        'Re-run the preview for that day and review it before committing.',
    )
  }

  // Re-validate at write time: the plan file is editable and may be stale.
  const v = validateEntries(planned.entries, {
    maxTotalHours: MAX_HOURS,
    allowDuplicates: ALLOW_DUPLICATES,
  })
  if (!v.ok) {
    throw new Error(`plan failed validation — ${v.problems.join('; ')}`)
  }

  console.log(`RECOVER (writing) — ${USERS[0]} ${DATE}, ${planned.entries.length} entr(ies), ${v.totalHours}h`)
  for (const e of planned.entries) {
    console.log(`  ${e.hours}h → ${e.harvest_project_name}`)
  }

  // Stage the reviewed entries, then hand off to the production confirm path
  // (which claims status='parsed' compare-and-set, logs each entry, posts the
  // DM confirmation, and records the Harvest ids).
  const { data: staged, error: stageErr } = await sb
    .from('daily_hours_checkins')
    .update({
      status: 'parsed',
      parsed_entries: planned.entries,
      reply_ts: planned.replyTs,
      updated_at: new Date().toISOString(),
    })
    .eq('id', open.id)
    .in('status', ['sent', 'nudged'])
    .select('id')
  if (stageErr) throw new Error(`stage failed: ${stageErr.message}`)
  if (!staged || staged.length === 0) {
    throw new Error('check-in is no longer stuck (already handled?) — nothing written')
  }

  await handleCheckinConfirm({ app, client, body: {}, checkinId: open.id })

  const { data: after } = await sb
    .from('daily_hours_checkins')
    .select('status, harvest_entry_ids, error_message')
    .eq('id', open.id)
    .maybeSingle()
  if (after?.status === 'logged') {
    console.log(`\n✓ Logged Harvest #${(after.harvest_entry_ids || []).join(', ')}`)
  } else {
    console.log(`\n! status=${after?.status} ${after?.error_message || ''}`)
  }
}

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN required')
  if (COMMIT && (USERS.length !== 1 || !DATE)) {
    throw new Error(
      '--commit requires exactly one --user=<slackId> and one --date=YYYY-MM-DD ' +
        '(targeted recovery only — preview and review that day first).',
    )
  }

  const client = new WebClient(process.env.SLACK_BOT_TOKEN)
  const sb = createAdminClient()
  const rows = await loadStuck(sb)

  if (!COMMIT && rows.length === 0) {
    console.log(`No stuck check-ins ${DATE ? `on ${DATE}` : `on/after ${SINCE}`}.`)
    return
  }
  return COMMIT ? runCommit(sb, client, rows) : runPreview(sb, client, rows)
}

main().catch((err) => {
  console.error(String(err.message || err))
  process.exit(1)
})
