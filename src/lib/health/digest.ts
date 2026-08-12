/**
 * Daily health digest — pure formatting + check-in roll-up (unit-tested).
 *
 * The watchdog (`health-cron.ts`) only speaks up on a state *flip*. This digest
 * is the opposite: a once-a-day "here's where Kit stands" DM, sent even when
 * everything is green, so a slow-burn problem (a backlog quietly growing) is
 * visible before it becomes an incident. The time-logging section is always
 * shown and always first among the details — it is the failure class Kit exists
 * to never repeat (migration 048: confirms silently failed, no hours reached
 * Harvest).
 *
 * Everything here is pure so it can be tested without Slack or Supabase.
 */

import type { CheckResult } from './diff'

/** A daily_hours_checkins row, narrowed to the fields the roll-up needs. */
export interface CheckinRow {
  check_in_date: string // 'YYYY-MM-DD', the local check-in day
  status: string
  reply_ts: string | null
  harvest_entry_ids: unknown // jsonb: array of Harvest ids, or null
}

export interface CheckinSummary {
  /**
   * True when the check-in data could NOT be read (query/RLS/permission error).
   * A failed read must never look like a healthy zero backlog — that would
   * fabricate an all-clear for exactly the silent-failure class this exists to
   * catch — so this escalates the digest instead.
   */
  unavailable: boolean
  loggedToday: number
  /** Past-day rows where the person replied but the hours never logged. */
  repliedUnlogged: number
  /** Past-day DMs that were never answered — soft, the person's choice. */
  sentNoReply: number
  // --- The migration-048 class. Any of these > 0 is urgent. ---
  failed: number
  stuckLogging: number
  loggedWithoutIds: number
  harvestIdButStuck: number
  /** Oldest past-day check_in_date still unlogged (reply present), or null. */
  oldestUnlogged: string | null
}

/** The summary to use when the check-in data could not be loaded. */
export function unavailableCheckinSummary(): CheckinSummary {
  return {
    unavailable: true,
    loggedToday: 0,
    repliedUnlogged: 0,
    sentNoReply: 0,
    failed: 0,
    stuckLogging: 0,
    loggedWithoutIds: 0,
    harvestIdButStuck: 0,
    oldestUnlogged: null,
  }
}

// Statuses that are NOT part of the "replied but unlogged" backlog: 'logged'
// and 'skipped' are genuinely done, and 'failed' is already reported by its own
// counter — counting a failed row here too would double-report one row as both
// "N confirms FAILED" and "N replies still unlogged" (matches the runbook SQL,
// which scopes replied_but_unlogged to the non-terminal, non-failed statuses).
const BACKLOG_EXCLUDE = new Set(['logged', 'skipped', 'failed'])

// Open (awaiting a reply) statuses. A row here is unanswered even if it carries
// a stale reply_ts — reply.ts's reopen() reverts a non-hours/unparseable reply
// back to 'sent' and historically left reply_ts set — so it must count as
// sent-no-reply, never as a lost-hours "reply", regardless of that timestamp.
const OPEN_STATUSES = new Set(['sent', 'nudged'])

function hasHarvestIds(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

/**
 * Roll up recent check-ins into the counts the digest reports.
 * `todayISO` is today's date in the studio timezone ('YYYY-MM-DD'); a row is
 * "past day" when its check_in_date is strictly before it.
 */
export function summarizeCheckins(rows: CheckinRow[], todayISO: string): CheckinSummary {
  const s: CheckinSummary = {
    unavailable: false,
    loggedToday: 0,
    repliedUnlogged: 0,
    sentNoReply: 0,
    failed: 0,
    stuckLogging: 0,
    loggedWithoutIds: 0,
    harvestIdButStuck: 0,
    oldestUnlogged: null,
  }
  for (const r of rows) {
    const past = r.check_in_date < todayISO
    const replied = !!r.reply_ts
    const logged = r.status === 'logged'

    if (r.status === 'failed') s.failed++
    if (r.status === 'logging') s.stuckLogging++
    if (logged && !hasHarvestIds(r.harvest_entry_ids)) s.loggedWithoutIds++
    // Only 'parsed' — a row that never advanced past parsing yet carries a
    // Harvest id (the real, unexplained inconsistency). A 'failed' row can
    // legitimately carry ids from a partial success (confirm.ts logs matched
    // entries, fails the rest); counting it here would double-report one row.
    if (r.status === 'parsed' && hasHarvestIds(r.harvest_entry_ids)) s.harvestIdButStuck++

    if (r.check_in_date === todayISO && logged) s.loggedToday++

    if (past && !BACKLOG_EXCLUDE.has(r.status)) {
      if (replied && !OPEN_STATUSES.has(r.status)) {
        s.repliedUnlogged++
        if (!s.oldestUnlogged || r.check_in_date < s.oldestUnlogged) s.oldestUnlogged = r.check_in_date
      } else {
        s.sentNoReply++
      }
    }
  }
  return s
}

/** True when the check-in state shows the acute, drop-everything failure class. */
export function checkinsUrgent(s: CheckinSummary): boolean {
  return (
    s.unavailable ||
    s.failed > 0 ||
    s.stuckLogging > 0 ||
    s.loggedWithoutIds > 0 ||
    s.harvestIdButStuck > 0
  )
}

const INTEGRATION_ORDER = ['dropbox', 'frameio', 'harvest', 'supabase', 'google']

/**
 * Render the Slack (mrkdwn) digest. Pure: give it the check results, the
 * check-in roll-up, and a human date label; it returns the message text.
 */
export function formatHealthDigest(
  checks: CheckResult[],
  checkins: CheckinSummary,
  dateLabel: string,
): string {
  const integrations = checks.filter((c) => !c.key.startsWith('cron:'))
  const crons = checks.filter((c) => c.key.startsWith('cron:'))
  const downInteg = integrations.filter((c) => !c.ok)
  const downCron = crons.filter((c) => !c.ok)
  const timeUrgent = checkinsUrgent(checkins)
  const issues = downInteg.length + downCron.length + (timeUrgent ? 1 : 0)

  const head =
    issues === 0
      ? `:white_check_mark: *Kit health — ${dateLabel}* — all systems go.`
      : `:rotating_light: *Kit health — ${dateLabel}* — ${issues} ${issues === 1 ? 'issue' : 'issues'}.`

  const lines: string[] = [head, '']

  // Integrations
  if (downInteg.length === 0) {
    const names = integrations
      .slice()
      .sort((a, b) => INTEGRATION_ORDER.indexOf(a.key) - INTEGRATION_ORDER.indexOf(b.key))
      .map((c) => c.label)
    lines.push(`*Integrations:* ${names.join(', ')} — all up.`)
  } else {
    lines.push('*Integrations:*')
    for (const c of downInteg) lines.push(`  :red_circle: *${c.label}* — ${c.detail || 'failing'}`)
    const upCount = integrations.length - downInteg.length
    if (upCount > 0) lines.push(`  (${upCount} other${upCount === 1 ? '' : 's'} up)`)
  }

  // Crons
  if (downCron.length === 0) {
    lines.push(`*Crons:* ${crons.length}/${crons.length} fresh.`)
  } else {
    lines.push('*Crons:*')
    for (const c of downCron) lines.push(`  :red_circle: *${c.label}* — ${c.detail || 'stale'}`)
  }

  // Time logging — always shown, always emphasised.
  lines.push(formatTimeLoggingLine(checkins))

  return lines.join('\n')
}

function formatTimeLoggingLine(s: CheckinSummary): string {
  if (s.unavailable) {
    return `*Time logging:* :rotating_light: check-in data could not be read — the daily_hours_checkins query failed. This can mask stuck or unlogged hours; investigate before trusting the rest.`
  }
  if (checkinsUrgent(s)) {
    const parts: string[] = []
    if (s.failed) parts.push(`${s.failed} confirm${s.failed === 1 ? '' : 's'} FAILED`)
    if (s.stuckLogging) parts.push(`${s.stuckLogging} stuck in 'logging' (migration-048 signature)`)
    if (s.loggedWithoutIds) parts.push(`${s.loggedWithoutIds} logged with no Harvest id`)
    if (s.harvestIdButStuck) parts.push(`${s.harvestIdButStuck} Harvest id but status stuck`)
    const tail = s.repliedUnlogged
      ? ` Also ${s.repliedUnlogged} past-day repl${s.repliedUnlogged === 1 ? 'y' : 'ies'} still unlogged.`
      : ''
    return `*Time logging:* :rotating_light: ${parts.join('; ')}.${tail}`
  }
  const backlog =
    s.repliedUnlogged === 0
      ? 'no replies waiting from past days'
      : `:warning: ${s.repliedUnlogged} past-day repl${s.repliedUnlogged === 1 ? 'y' : 'ies'} still unlogged${
          s.oldestUnlogged ? ` (oldest ${s.oldestUnlogged})` : ''
        }`
  return `*Time logging:* :white_check_mark: no failed or stuck check-ins. ${s.loggedToday} logged today, ${backlog}.`
}
