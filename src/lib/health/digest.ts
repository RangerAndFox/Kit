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
  parsed_entries?: unknown
  error_message?: string | null
  origin?: string | null
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
  /** Positive, fully-resolved entries still waiting for the person's confirmation. */
  awaitingConfirmation: number
  /** Positive entries that cannot log until the person corrects a project match. */
  needsClarification: number
  /** Old parsed cards outside the safe automatic-confirmation window. */
  expired: number
  /** Partial confirmations where at least one Harvest write succeeded. */
  partialFailures: number
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
    awaitingConfirmation: 0,
    needsClarification: 0,
    expired: 0,
    partialFailures: 0,
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
const BACKLOG_EXCLUDE = new Set(['logged', 'skipped', 'failed', 'expired'])

// Open (awaiting a reply) statuses. A row here is unanswered even if it carries
// a stale reply_ts — reply.ts's reopen() reverts a non-hours/unparseable reply
// back to 'sent' and historically left reply_ts set — so it must count as
// sent-no-reply, never as a lost-hours "reply", regardless of that timestamp.
const OPEN_STATUSES = new Set(['sent', 'nudged'])
const CHECKIN_ACTIONABLE_DAYS = 14

function hasHarvestIds(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

function parsedEntries(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}

function positiveEntries(v: unknown): any[] {
  return parsedEntries(v).filter((e) => Number(e?.hours) > 0)
}

function dateMinusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
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
    awaitingConfirmation: 0,
    needsClarification: 0,
    expired: 0,
    partialFailures: 0,
    sentNoReply: 0,
    failed: 0,
    stuckLogging: 0,
    loggedWithoutIds: 0,
    harvestIdButStuck: 0,
    oldestUnlogged: null,
  }
  const actionableCutoff = dateMinusDays(todayISO, CHECKIN_ACTIONABLE_DAYS)
  for (const r of rows) {
    const past = r.check_in_date < todayISO
    const replied = !!r.reply_ts
    const logged = r.status === 'logged'

    if (r.status === 'failed') {
      if (hasHarvestIds(r.harvest_entry_ids)) s.partialFailures++
      else s.failed++
    }
    if (r.status === 'logging') s.stuckLogging++
    // Entries reconciled against Harvest by an operator are complete even when
    // Kit did not create (and therefore could not capture) the provider IDs.
    // Keep the explicit origin marker auditable without manufacturing a daily
    // health incident for hours already verified in Harvest.
    if (logged && !hasHarvestIds(r.harvest_entry_ids) && r.origin !== 'manual-reconciliation') s.loggedWithoutIds++
    // Only 'parsed' — a row that never advanced past parsing yet carries a
    // Harvest id (the real, unexplained inconsistency). A 'failed' row can
    // legitimately carry ids from a partial success (confirm.ts logs matched
    // entries, fails the rest); counting it here would double-report one row.
    if (r.status === 'parsed' && hasHarvestIds(r.harvest_entry_ids) && r.origin !== 'partial-retry') {
      s.harvestIdButStuck++
    }

    if (r.check_in_date === todayISO && logged) s.loggedToday++

    if (r.status === 'expired') {
      s.expired++
      continue
    }

    if (past && r.status === 'parsed') {
      const positive = positiveEntries(r.parsed_entries)
      // A zero-hour parse is not missing time. The reconciliation step closes
      // these rows, but ignore them here immediately so one stale row cannot
      // manufacture a health incident before cleanup runs.
      if (positive.length === 0) continue
      if (r.check_in_date < actionableCutoff) {
        s.expired++
        continue
      }
      if (positive.some((e) => e.resolution !== 'matched' || !e.harvest_project_id)) {
        s.needsClarification++
      } else {
        s.awaitingConfirmation++
      }
      s.repliedUnlogged++
      if (!s.oldestUnlogged || r.check_in_date < s.oldestUnlogged) s.oldestUnlogged = r.check_in_date
      continue
    }

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
    if (s.failed) parts.push(`${s.failed} confirmation${s.failed === 1 ? '' : 's'} failed before anything logged`)
    if (s.stuckLogging) parts.push(`${s.stuckLogging} stuck in 'logging' (migration-048 signature)`)
    if (s.loggedWithoutIds) parts.push(`${s.loggedWithoutIds} logged with no Harvest id`)
    if (s.harvestIdButStuck) parts.push(`${s.harvestIdButStuck} Harvest id but status stuck`)
    const tail = formatPendingDetails(s)
    return `*Time logging:* :rotating_light: ${parts.join('; ')}.${tail}`
  }
  const details = formatPendingDetails(s).trim()
  const backlog = details || 'no actionable confirmations waiting from past days'
  return `*Time logging:* :white_check_mark: no failed or stuck check-ins. ${s.loggedToday} logged today, ${backlog}.`
}

function formatPendingDetails(s: CheckinSummary): string {
  const parts: string[] = []
  if (s.awaitingConfirmation) parts.push(`${s.awaitingConfirmation} awaiting confirmation`)
  if (s.needsClarification) parts.push(`${s.needsClarification} need${s.needsClarification === 1 ? 's' : ''} project clarification`)
  if (s.partialFailures) parts.push(`${s.partialFailures} partially logged; failed line needs correction`)
  if (s.expired) parts.push(`${s.expired} expired card${s.expired === 1 ? '' : 's'} require manual review`)
  if (!parts.length) return ''
  const oldest = s.oldestUnlogged ? ` (oldest actionable ${s.oldestUnlogged})` : ''
  return ` :warning: ${parts.join('; ')}${oldest}`
}
