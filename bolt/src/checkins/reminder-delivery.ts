// @ts-nocheck
/**
 * Daily-hours reminder — durable occurrence + effectively-once delivery.
 *
 * Why this exists: the old sender (daily-hours.ts) posted the DM, then inserted
 * a tracking row only AFTER a successful post, and eligibility was an exact-hour
 * equality (`localHour === 17`) checked at discrete hourly ticks. So a missed
 * tick, a Railway restart, a transient Slack failure, a post-before-record
 * crash, or a travel-timezone transition (5pm-local falling between two ticks)
 * permanently lost that day's reminder — nothing recorded it as owed, nothing
 * recovered it. This module makes each (staff, local workday) a durably-claimed
 * occurrence (daily_hours_reminders) and the SINGLE source of scheduling +
 * delivery state, with bounded catch-up and metadata reconciliation.
 *
 * Delivery guarantee, precisely (mirrors agent/briefing-delivery.ts):
 *   - The UNIQUE(staff, local_date, type) row + compare-and-set claim guarantee
 *     EXCLUSIVE PROCESSING: at most one worker acts on an occurrence at a time
 *     and a re-sweep cannot create a second occurrence. This alone does NOT
 *     guarantee a single Slack message.
 *   - EFFECTIVELY-ONCE delivery additionally requires reconciliation: after an
 *     ambiguous (timeout) send we never repost unless conversations.history +
 *     message metadata proves the message is absent. If reconciliation is
 *     unavailable the occurrence stays `unconfirmed` and is surfaced — never
 *     reposted. It is NOT exactly-once (Slack has no idempotency key).
 *
 * Destination: Kit's direct-message conversation with the recipient, opened via
 * conversations.open. The returned D… channel id is stored on the occurrence
 * and check-in rows so replies, confirmation cards, nudges, and reconciliation
 * all remain bound to the same conversation.
 *
 * On a successful send the occurrence creates the daily_hours_checkins row (the
 * conversation record) so every existing reply / confirm / nudge / missing-time
 * path keeps working unchanged.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { resolveUserTimezone } from './user-tz'
import { checkinToday, isWorkday, isStudioHoliday } from './date'
import { isOnTimeOff } from '../../../src/lib/staff/time-off'
import { composeDm, localHourAt } from './daily-hours'

const REMINDER_TYPE = 'daily_hours'

// ─── Config (documented, env-overridable, clamped) ───────────────────────────

/** The local hour a reminder becomes due (5pm by default). */
export function dueHour(): number {
  const h = Number(process.env.HOURS_REMINDER_DUE_HOUR)
  return Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : 17
}

/**
 * The local hour after which a still-unresolved occurrence is EXPIRED instead of
 * delivered. Bounds catch-up to work hours: a restart at 5:15 or 6:00 still
 * delivers, but we never fire a stale reminder late at night just because the
 * process recovered. Default 21 (9pm) — a 4-hour catch-up window after 5pm.
 */
export function cutoffHour(): number {
  const h = Number(process.env.HOURS_REMINDER_CUTOFF_HOUR)
  const due = dueHour()
  if (!Number.isFinite(h)) return Math.max(due + 1, 21)
  return Math.max(due + 1, Math.min(24, h))
}

/** Claim lease: how long a claim is held before another sweep may reclaim it. */
export function leaseMs(): number {
  const s = Number(process.env.HOURS_REMINDER_CLAIM_LEASE_SECONDS) || 120
  return Math.max(30, Math.min(600, s)) * 1000
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** The recipient's local hour (0–23) at `now` in `tz`. Pure. */
export function resolveLocalHour(now: Date, tz: string): number {
  return localHourAt(now, tz)
}

/**
 * Which phase of the day the recipient is in, relative to the due/cutoff window.
 *   before → not due yet (no occurrence created)
 *   window → due and within the catch-up window (create + deliver)
 *   after  → past the cutoff (expire any unresolved occurrence; never post)
 * Pure — unit-tested.
 */
export function reminderWindowPhase(
  localHour: number,
  due: number = dueHour(),
  cutoff: number = cutoffHour(),
): 'before' | 'window' | 'after' {
  if (localHour < due) return 'before'
  if (localHour >= cutoff) return 'after'
  return 'window'
}

/**
 * Slack message `metadata` carrying the opaque occurrence id. Echoed back by
 * conversations.history (include_all_metadata) so an `unconfirmed` send can be
 * reconciled without embedding anything in the visible reminder text. Pure.
 * event_type must match Slack's `^[A-Za-z0-9_-]+$`.
 */
export function buildReminderMetadata(reminderId: string) {
  return {
    event_type: 'kit_hours_reminder',
    event_payload: { reminder_id: String(reminderId) },
  }
}

/**
 * Scan a page of conversations.history messages for one carrying our occurrence
 * id in metadata, returning its ts. Pure — unit-tested. Depends only on the
 * metadata we set (not on client_msg_id, undocumented for bot posts).
 */
export function findReminderTsInHistory(messages: any[], reminderId: string): string | null {
  for (const m of messages || []) {
    const payload = m?.metadata?.event_payload
    if (
      m?.metadata?.event_type === 'kit_hours_reminder' &&
      payload &&
      String(payload.reminder_id) === String(reminderId) &&
      m.ts
    ) {
      return m.ts
    }
  }
  return null
}

/**
 * Whether a prior attempt might already have posted, so we must reconcile before
 * re-posting. True for any non-fresh state. Pure — unit-tested.
 */
export function shouldReconcile(prevStatus: string | null | undefined): boolean {
  return prevStatus === 'unconfirmed' || prevStatus === 'claimed' || prevStatus === 'posting'
}

/**
 * Classify a Slack post result into the three delivery-relevant outcomes. Pure.
 *   - ok        → delivered, ts known.
 *   - ambiguous → the request threw (timeout/network); Slack MAY have posted.
 *                 Do not mark sent; reconcile on the next attempt.
 *   - failed    → Slack returned ok:false (definitely not posted); safe to
 *                 re-post on retry.
 */
export function classifyPostOutcome(input: {
  threw?: boolean
  ok?: boolean
  ts?: string | null
  error?: string | null
}): { kind: 'ok'; ts: string } | { kind: 'ambiguous'; error: string } | { kind: 'failed'; error: string } {
  if (input.threw) return { kind: 'ambiguous', error: input.error || 'request failed before ack' }
  if (input.ok && input.ts) return { kind: 'ok', ts: input.ts }
  return { kind: 'failed', error: input.error || 'unknown Slack error' }
}

/** Open (or reuse) Kit's direct-message conversation with one Slack user. */
export async function resolveHoursReminderDm(app: App, slackUserId: string): Promise<string> {
  if (!slackUserId) throw new Error('slackUserId required')
  const opened: any = await app.client.conversations.open({ users: slackUserId })
  if (!opened?.ok) throw new Error(`conversations.open: ${opened?.error || 'unknown Slack error'}`)
  const channelId = opened.channel?.id
  if (!channelId) throw new Error('conversations.open returned no channel')
  return channelId
}

// ─── Reconciliation result (safety boundary — mirrors briefing-delivery) ──────

export type ReconcileResult =
  | { outcome: 'found'; ts: string }
  | { outcome: 'absent' }
  | { outcome: 'unavailable'; error: string }

// ─── Injected side-effects (so the machine is unit-testable, no DB/network) ───

export interface ReminderStaff {
  id: string
  slack_user_id: string
  full_name: string | null
  harvest_user_id: number | null
}

export interface ReminderRow {
  id: string
  status: string
  slack_channel_id: string | null
  slack_message_ts?: string | null
  attempts?: number | null
}

export interface ReminderDeps {
  /** Insert-if-absent the occurrence for (staff, local_date); return the row. */
  ensureRow(staff: ReminderStaff, localDate: string, tz: string): Promise<ReminderRow>
  /** Read an existing occurrence without creating one (used after cutoff). */
  findRow(staffId: string, localDate: string): Promise<ReminderRow | null>
  /** Compare-and-set claim; true iff THIS caller won. */
  claim(id: string): Promise<boolean>
  mark(id: string, patch: Record<string, unknown>): Promise<void>
  /**
   * Whether an existing daily_hours_checkins row already satisfies today's
   * reminder (a logged/open check-in, scheduled OR ad-hoc). Mirrors the old
   * sender's duplicate guard so ad-hoc logging still suppresses the reminder.
   */
  isSatisfied(staffId: string, localDate: string): Promise<boolean>
  resolveChannel(staff: ReminderStaff): Promise<string>
  reconcile(channelId: string, reminderId: string): Promise<ReconcileResult>
  post(
    channelId: string,
    text: string,
    reminderId: string,
  ): Promise<ReturnType<typeof classifyPostOutcome>>
  /**
   * Ensure the daily_hours_checkins conversation row exists for this delivered
   * reminder (idempotent) and return its id, so replies/confirm/nudge work.
   */
  recordConversation(input: {
    staff: ReminderStaff
    localDate: string
    channelId: string
    ts: string
  }): Promise<string | null>
}

export type ReminderOutcome =
  | { status: 'sent'; ts: string; reconciled?: boolean; already?: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'unconfirmed'; reason: string }
  | { status: 'locked' }

export type AfterCutoffOutcome =
  | { status: 'sent'; ts: string; reconciled: true }
  | { status: 'expired' }
  | { status: 'unconfirmed'; reason: string }
  | { status: 'locked' }
  | { status: 'none' }

// ─── The occurrence + delivery state machine ─────────────────────────────────

/**
 * Deliver one daily-hours reminder to one staff member, effectively-once.
 *
 * Idempotent by construction:
 *   - already 'sent'/'skipped'   → returns without posting.
 *   - already satisfied (ad-hoc/existing check-in) → marks 'skipped', no post.
 *   - concurrent live claim      → returns 'locked' (the holder finishes).
 *   - prior attempt may have posted → reconcile via metadata before re-posting.
 *   - ambiguous post             → 'unconfirmed', no repost until reconciled.
 *
 * Unlike the briefing machine this does NOT throw for control flow: the retry
 * mechanism is the next hourly sweep (which reclaims 'failed'/'unconfirmed'),
 * not an Inngest step, so it returns a status the sweep tallies.
 */
export async function deliverHoursReminder(
  opts: { staff: ReminderStaff; localDate: string; tz: string; text: string },
  deps: ReminderDeps,
): Promise<ReminderOutcome> {
  const { staff, localDate, tz, text } = opts

  const row = await deps.ensureRow(staff, localDate, tz)
  if (!row) return { status: 'failed', reason: 'could not create occurrence row' }
  if (row.status === 'sent') {
    return { status: 'sent', ts: row.slack_message_ts || '', already: true }
  }
  if (row.status === 'skipped') {
    return { status: 'skipped', reason: 'already resolved' }
  }

  // Ad-hoc / existing satisfaction: if the person already has a logged or open
  // check-in for their local day, the scheduled reminder is satisfied — mark it
  // skipped and never post (preserves the old sender's duplicate guard).
  if (await deps.isSatisfied(staff.id, localDate)) {
    await deps.mark(row.id, { status: 'skipped', skip_reason: 'satisfied_existing', error: null })
    return { status: 'skipped', reason: 'satisfied_existing' }
  }

  // No Harvest mapping → a visible, durable reason. Reclaimable within the
  // window so a same-day mapping fix recovers on the next sweep.
  if (!staff.harvest_user_id) {
    await deps.mark(row.id, { status: 'failed', error: 'no_harvest_mapping' })
    return { status: 'failed', reason: 'no_harvest_mapping' }
  }

  const prevStatus = row.status
  const won = await deps.claim(row.id)
  if (!won) return { status: 'locked' }

  const channel = await deps.resolveChannel(staff)

  // finalize: ensure the conversation row (idempotent) then mark sent.
  const finalizeSent = async (ts: string, reconciled: boolean): Promise<ReminderOutcome> => {
    const checkInId = await deps.recordConversation({ staff, localDate, channelId: channel, ts })
    await deps.mark(row.id, {
      status: 'sent',
      slack_message_ts: ts,
      slack_channel_id: channel,
      check_in_id: checkInId,
      error: null,
    })
    return { status: 'sent', ts, reconciled }
  }

  // If a prior attempt might have posted, reconcile BEFORE posting — a safety
  // boundary, not an optimization.
  //   found       → already delivered; mark sent.
  //   absent      → confirmed not delivered; fall through and (re)post.
  //   unavailable → cannot prove state; NEVER repost. Stay 'unconfirmed'.
  if (shouldReconcile(prevStatus) || row.slack_channel_id) {
    const rec = await deps.reconcile(channel, row.id)
    if (rec.outcome === 'found') return finalizeSent(rec.ts, true)
    if (rec.outcome === 'unavailable') {
      await deps.mark(row.id, {
        status: 'unconfirmed',
        slack_channel_id: channel,
        error: `reconciliation unavailable — not reposting: ${rec.error}`,
      })
      return { status: 'unconfirmed', reason: `unreconcilable: ${rec.error}` }
    }
    // absent → safe to (re)post below.
  }

  await deps.mark(row.id, { status: 'posting', slack_channel_id: channel })
  const outcome = await deps.post(channel, text, row.id)

  if (outcome.kind === 'ok') return finalizeSent(outcome.ts, false)

  if (outcome.kind === 'ambiguous') {
    // Slack MAY have delivered. Leave 'unconfirmed'; the next sweep reconciles
    // instead of re-posting blindly.
    await deps.mark(row.id, { status: 'unconfirmed', slack_channel_id: channel, error: outcome.error })
    return { status: 'unconfirmed', reason: outcome.error }
  }

  // Definitely not delivered — safe to re-post on the next sweep.
  await deps.mark(row.id, { status: 'failed', error: outcome.error })
  return { status: 'failed', reason: outcome.error }
}

/**
 * Resolve an existing occurrence after the delivery window without ever
 * posting. Ambiguous prior sends are reconciled first: found deliveries become
 * normal reply-compatible check-ins, proven absences expire, and unavailable
 * history remains unconfirmed for a later sweep. This prevents the cutoff from
 * swallowing a Slack message that was accepted before a timeout.
 */
export async function settleHoursReminderAfterCutoff(
  opts: { staff: ReminderStaff; localDate: string },
  deps: ReminderDeps,
): Promise<AfterCutoffOutcome> {
  const { staff, localDate } = opts
  const row = await deps.findRow(staff.id, localDate)
  if (!row || row.status === 'skipped') return { status: 'none' }
  if (row.status === 'sent') {
    return { status: 'sent', ts: row.slack_message_ts || '', reconciled: true }
  }

  const prevStatus = row.status
  const won = await deps.claim(row.id)
  if (!won) return { status: 'locked' }

  const mayHavePosted = shouldReconcile(prevStatus) || !!row.slack_channel_id
  if (!mayHavePosted) {
    await deps.mark(row.id, { status: 'skipped', skip_reason: 'window_closed', error: null })
    return { status: 'expired' }
  }

  let channel = row.slack_channel_id
  if (!channel) {
    try {
      channel = await deps.resolveChannel(staff)
    } catch (err: any) {
      const reason = err?.message || String(err)
      await deps.mark(row.id, {
        status: 'unconfirmed',
        error: `reconciliation unavailable — channel resolution failed: ${reason}`,
      })
      return { status: 'unconfirmed', reason }
    }
  }

  const rec = await deps.reconcile(channel, row.id)
  if (rec.outcome === 'unavailable') {
    await deps.mark(row.id, {
      status: 'unconfirmed',
      slack_channel_id: channel,
      error: `reconciliation unavailable after cutoff: ${rec.error}`,
    })
    return { status: 'unconfirmed', reason: rec.error }
  }
  if (rec.outcome === 'absent') {
    await deps.mark(row.id, {
      status: 'skipped',
      skip_reason: 'window_closed',
      slack_channel_id: channel,
      error: null,
    })
    return { status: 'expired' }
  }

  const checkInId = await deps.recordConversation({
    staff,
    localDate,
    channelId: channel,
    ts: rec.ts,
  })
  await deps.mark(row.id, {
    status: 'sent',
    slack_message_ts: rec.ts,
    slack_channel_id: channel,
    check_in_id: checkInId,
    error: null,
  })
  return { status: 'sent', ts: rec.ts, reconciled: true }
}

// ─── Production deps (Supabase ledger + Bolt Slack client) ────────────────────

const OPEN_OR_LOGGED = ['logged', 'sent', 'nudged', 'replied', 'parsed', 'logging']

export function makeDefaultDeps(app: App): ReminderDeps {
  const sb = createAdminClient()

  return {
    async ensureRow(staff, localDate, tz) {
      await sb
        .from('daily_hours_reminders')
        .upsert(
          {
            staff_id: staff.id,
            slack_user_id: staff.slack_user_id,
            local_date: localDate,
            reminder_type: REMINDER_TYPE,
            resolved_timezone: tz,
            status: 'pending',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'staff_id,local_date,reminder_type', ignoreDuplicates: true },
        )
      const { data } = await sb
        .from('daily_hours_reminders')
        .select('id, status, slack_channel_id, slack_message_ts, attempts')
        .eq('staff_id', staff.id)
        .eq('local_date', localDate)
        .eq('reminder_type', REMINDER_TYPE)
        .maybeSingle()
      return data
    },

    async findRow(staffId, localDate) {
      const { data, error } = await sb
        .from('daily_hours_reminders')
        .select('id, status, slack_channel_id, slack_message_ts, attempts')
        .eq('staff_id', staffId)
        .eq('local_date', localDate)
        .eq('reminder_type', REMINDER_TYPE)
        .maybeSingle()
      if (error) throw new Error(`findRow: ${error.message}`)
      return data
    },

    async claim(id) {
      const now = new Date()
      const lease = new Date(now.getTime() + leaseMs())
      const { data: current, error: readError } = await sb
        .from('daily_hours_reminders')
        .select('attempts')
        .eq('id', id)
        .maybeSingle()
      if (readError) throw new Error(`claim(read): ${readError.message}`)
      const patch = {
        status: 'claimed',
        claimed_at: now.toISOString(),
        lease_expires_at: lease.toISOString(),
        attempts: Number(current?.attempts || 0) + 1,
        updated_at: now.toISOString(),
      }
      // Two CAS attempts: fresh states, then stale-lease reclaim (supabase-js
      // can't express the OR-with-timestamp cleanly).
      const fresh = await sb
        .from('daily_hours_reminders')
        .update(patch)
        .eq('id', id)
        .in('status', ['pending', 'failed', 'unconfirmed'])
        .select('id')
      if (fresh.error) throw new Error(`claim(fresh): ${fresh.error.message}`)
      if ((fresh.data?.length || 0) > 0) return true

      const stale = await sb
        .from('daily_hours_reminders')
        .update(patch)
        .eq('id', id)
        .in('status', ['claimed', 'posting'])
        .lt('lease_expires_at', now.toISOString())
        .select('id')
      if (stale.error) throw new Error(`claim(stale): ${stale.error.message}`)
      return (stale.data?.length || 0) > 0
    },

    async mark(id, patch) {
      const { error } = await sb
        .from('daily_hours_reminders')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw new Error(`mark: ${error.message}`)
    },

    async isSatisfied(staffId, localDate) {
      const { data, error } = await sb
        .from('daily_hours_checkins')
        .select('id, status, origin')
        .eq('staff_id', staffId)
        .eq('check_in_date', localDate)
      if (error) throw new Error(`isSatisfied: ${error.message}`)
      return (data || []).some(
        (r: any) => r.origin === 'scheduled' || OPEN_OR_LOGGED.includes(r.status),
      )
    },

    resolveChannel(staff) {
      return resolveHoursReminderDm(app, staff.slack_user_id)
    },

    async reconcile(channelId, reminderId) {
      try {
        let cursor = ''
        for (let page = 0; page < 5; page++) {
          const res: any = await app.client.conversations.history({
            channel: channelId,
            include_all_metadata: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })
          if (!res.ok) return { outcome: 'unavailable', error: res.error || 'history failed' }
          const ts = findReminderTsInHistory(res.messages || [], reminderId)
          if (ts) return { outcome: 'found', ts }
          cursor = res.response_metadata?.next_cursor || ''
          if (!cursor) break
        }
        return { outcome: 'absent' }
      } catch (e: any) {
        // ok:false comes back as a thrown SlackError too — inconclusive, never absence.
        return { outcome: 'unavailable', error: e?.data?.error || e?.message || String(e) }
      }
    },

    async post(channelId, text, reminderId) {
      try {
        const res: any = await app.client.chat.postMessage({
          channel: channelId,
          text,
          metadata: buildReminderMetadata(reminderId),
        })
        return classifyPostOutcome({ ok: !!res.ok, ts: res.ts, error: res.ok ? null : res.error })
      } catch (e: any) {
        // A Slack API ok:false is thrown by the WebClient; distinguish it from a
        // true network/timeout throw. data.error present → definitive failure.
        if (e?.data && e.data.ok === false) {
          return classifyPostOutcome({ ok: false, error: e.data.error || 'slack_error' })
        }
        return classifyPostOutcome({ threw: true, error: e?.message || String(e) })
      }
    },

    async recordConversation({ staff, localDate, channelId, ts }) {
      // Idempotent: reuse an existing scheduled row for the day if present
      // (covers a reconcile-found re-run or a prior partial send).
      const { data: existing } = await sb
        .from('daily_hours_checkins')
        .select('id')
        .eq('staff_id', staff.id)
        .eq('check_in_date', localDate)
        .eq('origin', 'scheduled')
        .limit(1)
        .maybeSingle()
      if (existing?.id) return existing.id

      const { data, error } = await sb
        .from('daily_hours_checkins')
        .insert({
          staff_id: staff.id,
          slack_user_id: staff.slack_user_id,
          check_in_date: localDate,
          status: 'sent',
          origin: 'scheduled',
          candidate_projects: [],
          dm_channel_id: channelId,
          dm_ts: ts,
        })
        .select('id')
        .single()
      if (error) {
        console.warn(`[hours-reminder] conversation insert failed for ${staff.slack_user_id}: ${error.message}`)
        return null
      }
      return data.id
    },
  }
}

// ─── The hourly sweep (Railway cron entry point) ─────────────────────────────

export interface SweepTally {
  sent: number
  skipped: number
  failed: number
  unconfirmed: number
  locked: number
  notDue: number
  notWorkday: number
  expired: number
  /** Recipient has approved time off covering their local day. */
  timeOff: number
}

export interface SweepOptions {
  /** Delivery state machine deps (defaults to Supabase + Bolt Slack). */
  deps?: ReminderDeps
  /** The instant to evaluate (defaults to now). */
  now?: Date
  /** Load opted-in active staff (defaults to the daily_checkin+is_active query). */
  loadStaff?: () => Promise<ReminderStaff[]>
  /** Resolve a recipient's timezone (defaults to the Slack-profile resolver). */
  resolveTz?: (slackUserId: string) => Promise<string>
  /** Settle an existing occurrence after cutoff without posting. */
  settleAfterCutoff?: (
    staff: ReminderStaff,
    localDate: string,
    deps: ReminderDeps,
  ) => Promise<AfterCutoffOutcome>
  /** Is this person on approved time off that day? (defaults to staff_time_off). */
  isOnTimeOff?: (staffId: string, localDate: string) => Promise<boolean>
}

/**
 * Sweep all opted-in active staff. HOURLY: each person is delivered at/after 5pm
 * in THEIR timezone on their own workday calendar, with catch-up until the
 * cutoff. Work scales with active staff per tick (invariant 7) — it never scans
 * historical occurrences; ensure/claim/expire are all scoped to (staff, today).
 *
 * Per staff per tick:
 *   before window → not due yet.
 *   in window     → ensure occurrence + deliver (effectively-once).
 *   after cutoff  → expire any unresolved occurrence for the day (never post).
 *   weekend/holiday on their local day → skip.
 *
 * Eligibility (daily_checkin + is_active) is enforced by the default loader, so
 * inactive / opted-out staff never reach delivery. Dependencies are injectable
 * so the whole sweep is unit-testable without a DB or Slack.
 */
export async function sweepDailyReminders(
  app: App,
  options: SweepOptions = {},
): Promise<SweepTally> {
  // Lazily created so a fully-injected sweep (tests) never needs Supabase env.
  let _sb: any = null
  const sb = () => (_sb ||= createAdminClient())
  const now = options.now || new Date()
  const deps = options.deps || makeDefaultDeps(app)
  const resolveTz =
    options.resolveTz || ((slackUserId: string) => resolveUserTimezone({ app, slackUserId }))
  const settleAfterCutoff = options.settleAfterCutoff || ((staff, localDate, injectedDeps) =>
    settleHoursReminderAfterCutoff({ staff, localDate }, injectedDeps))
  const onTimeOff =
    options.isOnTimeOff ||
    ((staffId: string, localDate: string) => isOnTimeOff({ staffId, date: localDate }))
  const loadStaff =
    options.loadStaff ||
    (async () => {
      const { data, error } = await sb()
        .from('staff')
        .select('id, slack_user_id, full_name, harvest_user_id')
        .eq('daily_checkin', true)
        .eq('is_active', true)
      if (error) throw new Error(`load staff failed: ${error.message}`)
      return (data || []) as ReminderStaff[]
    })

  const staff = await loadStaff()

  const tally: SweepTally = {
    sent: 0, skipped: 0, failed: 0, unconfirmed: 0, locked: 0,
    notDue: 0, notWorkday: 0, expired: 0, timeOff: 0,
  }

  for (const s of staff) {
    try {
      const tz = await resolveTz(s.slack_user_id)
      const localDate = checkinToday(now, tz)
      const localHour = resolveLocalHour(now, tz)

      if (!isWorkday(localDate, tz)) {
        tally.notWorkday += 1
        continue
      }

      const phase = reminderWindowPhase(localHour)
      if (phase === 'before') {
        tally.notDue += 1
        continue
      }
      if (phase === 'after') {
        // Never send after cutoff. Reconcile an earlier ambiguous send before
        // deciding whether the occurrence can safely expire.
        const settled = await settleAfterCutoff(s, localDate, deps)
        if (settled.status === 'expired') tally.expired += 1
        else if (settled.status === 'sent') tally.sent += 1
        else if (settled.status === 'unconfirmed') tally.unconfirmed += 1
        else if (settled.status === 'locked') tally.locked += 1
        continue
      }

      // Approved time off is a non-working day for THIS person, so no occurrence
      // is created at all — a week of PTO leaves nothing to chase rather than a
      // week of unanswered reminders. Checked here, after the due-window gate,
      // so it costs one lookup only for people actually due this tick rather
      // than one per person per hour. A lookup FAILURE must never resolve to
      // "not on PTO" (that resumes nagging someone on vacation), so it throws to
      // the per-person catch: this cycle is skipped and the next tick retries.
      if (await onTimeOff(s.id, localDate)) {
        tally.timeOff += 1
        continue
      }

      const text = composeDm({ firstName: (s.full_name || '').split(/\s+/)[0] || 'there' })
      const r = await deliverHoursReminder({ staff: s, localDate, tz, text }, deps)
      tally[r.status] += 1
      if (r.status === 'failed' || r.status === 'unconfirmed') {
        console.warn(`[hours-reminder] ${s.slack_user_id} ${r.status}: ${(r as any).reason}`)
      }
    } catch (err: any) {
      tally.failed += 1
      console.error(`[hours-reminder] sweep error for ${s.slack_user_id}: ${err?.message || err}`)
    }
  }

  if (tally.sent || tally.failed || tally.unconfirmed || tally.expired) {
    console.log(
      `[hours-reminder] sweep done — sent=${tally.sent} skipped=${tally.skipped} ` +
        `failed=${tally.failed} unconfirmed=${tally.unconfirmed} locked=${tally.locked} ` +
        `expired=${tally.expired} notDue=${tally.notDue} notWorkday=${tally.notWorkday}`,
    )
  }
  return tally
}

// ─── Read-only operator diagnostic (secret-safe) ─────────────────────────────

export interface ReminderDiagnostic {
  slack_user_id: string
  local_date: string
  eligibility: {
    daily_checkin: boolean | null
    is_active: boolean | null
    has_harvest_mapping: boolean
    resolved_timezone: string | null
    local_hour_now: number | null
    is_workday: boolean | null
    is_holiday: boolean | null
    on_time_off: boolean | null
    due_hour: number
    cutoff_hour: number
    window_phase: 'before' | 'window' | 'after' | null
  }
  occurrence: {
    status: string
    skip_reason: string | null
    error: string | null
    attempts: number | null
    slack_channel_id: string | null
    has_message_ts: boolean
    claimed_at: string | null
    lease_expires_at: string | null
    check_in_id: string | null
  } | null
  check_in: { status: string; origin: string } | null
  notes: string[]
}

/**
 * Assemble a read-only diagnostic for one staff member + date from
 * already-fetched rows. PURE — unit-tested, and DELIBERATELY carries no tokens
 * and no message bodies (only a boolean for whether a ts exists). Everything a
 * secret would live in (Slack token, DM text) is intentionally absent.
 */
export function buildReminderDiagnostic(input: {
  slackUserId: string
  localDate: string
  staff: { daily_checkin?: boolean | null; is_active?: boolean | null; harvest_user_id?: number | null } | null
  tz: string | null
  localHour: number | null
  occurrence: any | null
  checkIn: { status: string; origin: string } | null
  /** Approved time off covering localDate; null when it could not be read. */
  onTimeOff?: boolean | null
}): ReminderDiagnostic {
  const { slackUserId, localDate, staff, tz, localHour, occurrence, checkIn } = input
  const onTimeOff = input.onTimeOff ?? null
  const notes: string[] = []
  if (!staff) notes.push('no staff row for this slack_user_id')
  else {
    if (!staff.daily_checkin) notes.push('daily_checkin is off — not eligible')
    if (!staff.is_active) notes.push('staff is inactive — not eligible')
    if (!staff.harvest_user_id) notes.push('no Harvest mapping — reminder will fail with no_harvest_mapping')
  }
  const workday = tz ? isWorkday(localDate, tz) : null
  const holiday = isStudioHoliday(localDate)
  if (workday === false) notes.push('local day is a weekend/holiday — no occurrence expected')
  if (onTimeOff === true) notes.push('on approved time off — no occurrence expected')
  const phase = localHour != null ? reminderWindowPhase(localHour) : null
  if (!occurrence) notes.push('no occurrence row for this (staff, date)')

  return {
    slack_user_id: slackUserId,
    local_date: localDate,
    eligibility: {
      daily_checkin: staff?.daily_checkin ?? null,
      is_active: staff?.is_active ?? null,
      has_harvest_mapping: !!staff?.harvest_user_id,
      resolved_timezone: tz,
      local_hour_now: localHour,
      is_workday: workday,
      is_holiday: holiday,
      on_time_off: onTimeOff,
      due_hour: dueHour(),
      cutoff_hour: cutoffHour(),
      window_phase: phase,
    },
    occurrence: occurrence
      ? {
          status: occurrence.status,
          skip_reason: occurrence.skip_reason ?? null,
          error: occurrence.error ?? null,
          attempts: occurrence.attempts ?? null,
          slack_channel_id: occurrence.slack_channel_id ?? null,
          has_message_ts: !!occurrence.slack_message_ts,
          claimed_at: occurrence.claimed_at ?? null,
          lease_expires_at: occurrence.lease_expires_at ?? null,
          check_in_id: occurrence.check_in_id ?? null,
        }
      : null,
    check_in: checkIn,
    notes,
  }
}

/** Fetch + assemble the read-only diagnostic for one staff member + date. */
export async function diagnoseHoursReminder(opts: {
  app: App
  slackUserId: string
  date?: string
}): Promise<ReminderDiagnostic> {
  const sb = createAdminClient()
  const { data: staff } = await sb
    .from('staff')
    .select('id, daily_checkin, is_active, harvest_user_id')
    .eq('slack_user_id', opts.slackUserId)
    .maybeSingle()

  let tz: string | null = null
  let localHour: number | null = null
  try {
    tz = await resolveUserTimezone({ app: opts.app, slackUserId: opts.slackUserId })
    localHour = resolveLocalHour(new Date(), tz)
  } catch {
    /* diagnostic stays best-effort */
  }
  const localDate = opts.date || checkinToday(new Date(), tz || undefined)

  let occurrence: any = null
  let checkIn: { status: string; origin: string } | null = null
  if (staff?.id) {
    const { data: occ } = await sb
      .from('daily_hours_reminders')
      .select(
        'status, skip_reason, error, attempts, slack_channel_id, slack_message_ts, claimed_at, lease_expires_at, check_in_id',
      )
      .eq('staff_id', staff.id)
      .eq('local_date', localDate)
      .eq('reminder_type', REMINDER_TYPE)
      .maybeSingle()
    occurrence = occ
    const { data: ci } = await sb
      .from('daily_hours_checkins')
      .select('status, origin')
      .eq('staff_id', staff.id)
      .eq('check_in_date', localDate)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    checkIn = ci
  }

  // Best-effort: an operator asking "why did X get no reminder?" needs time off
  // in the answer, otherwise the diagnostic shows a workday with no occurrence
  // and no reason. null (not false) when it can't be read, so an unreadable
  // lookup never reads as "definitely not on PTO".
  let onTimeOff: boolean | null = null
  if (staff) {
    try {
      onTimeOff = await isOnTimeOff({ staffId: staff.id, date: localDate })
    } catch {
      onTimeOff = null
    }
  }

  return buildReminderDiagnostic({
    slackUserId: opts.slackUserId,
    localDate,
    staff,
    tz,
    localHour,
    occurrence,
    checkIn,
    onTimeOff,
  })
}
