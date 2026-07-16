// @ts-nocheck
/**
 * Per-recipient briefing delivery — the atomic, idempotent delivery boundary.
 *
 * Why this exists: the old dispatch posted to Slack inside a retryable Inngest
 * step with no per-recipient claim, so a step retry (Slack accepted the post but
 * the 8s client fetch timed out, or Inngest re-ran the step) re-posted the same
 * briefing. This module makes each (occurrence, internal recipient) delivery an
 * atomically-claimed ledger row (meeting_briefing_deliveries) and the SINGLE
 * authoritative source of delivery state.
 *
 * Delivery guarantee, precisely:
 *   - The UNIQUE(occurrence, recipient) row + compare-and-set claim guarantee
 *     EXCLUSIVE PROCESSING: at most one worker acts on a delivery at a time, and
 *     a retry/re-scan cannot create a second delivery row. This alone does NOT
 *     guarantee a single Slack message.
 *   - EFFECTIVELY-ONCE delivery additionally requires reconciliation: after an
 *     ambiguous (timeout) send we never repost unless conversations.history +
 *     message metadata proves the message is absent. If reconciliation is
 *     unavailable, the delivery stays `unconfirmed` and is surfaced — it is
 *     never reposted. It is NOT exactly-once (Slack chat.postMessage has no
 *     idempotency key).
 *
 * State machine (per ledger row):
 *   pending → claimed → (posting) → sent                     (terminal, delivered)
 *   claimed/posting + expired lease → reclaimable            (crash-after-claim)
 *   post attempted, no ack (timeout/network) → unconfirmed   (indeterminate)
 *        → reconcile (metadata lookup) → sent, or re-post
 *   definitive Slack error → failed                          (Inngest retries)
 *
 * Pattern: the compare-and-set claim mirrors brain/scavenger.ts `claimCandidate`.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePersonalBriefingChannel } from './briefing-channel'
import type { BriefingRecipient } from './briefing-composer'

const SLACK_API = 'https://slack.com/api'

/** Claim lease: how long a claim is held before another attempt may reclaim it. */
export function leaseMs(): number {
  const m = Number(process.env.BRIEFING_CLAIM_LEASE_SECONDS) || 120
  return Math.max(30, Math.min(600, m)) * 1000
}

/**
 * Slack message `metadata` carrying the opaque delivery id. Echoed back by
 * conversations.history (include_all_metadata) so an `unconfirmed` send can be
 * reconciled without embedding anything in the visible briefing text. Pure.
 *
 * event_type must match Slack's `^[A-Za-z0-9_-]+$`.
 */
export function buildDeliveryMetadata(deliveryId: string) {
  return {
    event_type: 'kit_briefing_delivery',
    event_payload: { delivery_id: String(deliveryId) },
  }
}

/**
 * Scan a page of conversations.history messages for one carrying our delivery
 * id in metadata, returning its ts. Pure — unit-tested. Does NOT depend on
 * client_msg_id (undocumented for bot posts); only on the metadata we set.
 */
export function findDeliveryTsInHistory(messages: any[], deliveryId: string): string | null {
  for (const m of messages || []) {
    const payload = m?.metadata?.event_payload
    if (
      m?.metadata?.event_type === 'kit_briefing_delivery' &&
      payload &&
      String(payload.delivery_id) === String(deliveryId) &&
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
 * Classify a Slack post result into the three delivery-relevant outcomes.
 * Pure — unit-tested.
 *   - ok           → delivered, ts known.
 *   - ambiguous    → the request threw (timeout/network); Slack MAY have posted.
 *                    Do not mark sent; reconcile on the next attempt.
 *   - failed       → Slack returned ok:false (definitely not posted); safe to
 *                    re-post on retry.
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

async function slackCall(method: string, token: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

/**
 * Post the briefing with delivery metadata. Returns a classified outcome — the
 * caller decides ledger state. A fetch that throws (timeout/abort/network) is
 * AMBIGUOUS: Slack may have delivered, so we never mark it sent here.
 */
async function postBriefingMessage(opts: {
  token: string
  channel: string
  text: string
  deliveryId: string
}): Promise<ReturnType<typeof classifyPostOutcome>> {
  try {
    const { status, json } = await slackCall('chat.postMessage', opts.token, {
      channel: opts.channel,
      text: opts.text,
      mrkdwn: true,
      metadata: buildDeliveryMetadata(opts.deliveryId),
    })
    return classifyPostOutcome({
      ok: !!json.ok,
      ts: json.ts,
      error: json.ok ? null : json.error || String(status),
    })
  } catch (e: any) {
    return classifyPostOutcome({ threw: true, error: e?.message || String(e) })
  }
}

/**
 * Three-valued reconciliation result. The distinction is a SAFETY boundary:
 *   - found      → the message is in Slack; mark sent.
 *   - absent     → we successfully searched recent history and it is NOT there;
 *                  the earlier post did not land — eligible to (re)post.
 *   - unavailable→ we could NOT determine the state (missing groups:history
 *                  scope, API error, or the history call timed out). We must
 *                  NOT repost — a repost after an ambiguous send can duplicate.
 */
export type ReconcileResult =
  | { outcome: 'found'; ts: string }
  | { outcome: 'absent' }
  | { outcome: 'unavailable'; error: string }

/**
 * Look for an already-posted message for this delivery in the recipient's
 * private channel via conversations.history + message metadata. Requires the
 * `groups:history` bot scope (private channels). Bounded paging over the recent
 * window (reconciliation runs seconds/minutes after the ambiguous post, so the
 * message is near the top). Never returns `absent` on an error — an error is
 * `unavailable`, which the caller treats as "do not repost".
 */
async function reconcileDelivery(opts: {
  token: string
  channelId: string
  deliveryId: string
}): Promise<ReconcileResult> {
  try {
    let cursor = ''
    for (let page = 0; page < 5; page++) {
      const { json } = await slackCall('conversations.history', opts.token, {
        channel: opts.channelId,
        include_all_metadata: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      // ok:false (e.g. missing_scope, channel_not_found, ratelimited) means we
      // cannot prove delivery state — inconclusive, NOT absence.
      if (!json.ok) return { outcome: 'unavailable', error: json.error || 'conversations.history failed' }
      const ts = findDeliveryTsInHistory(json.messages || [], opts.deliveryId)
      if (ts) return { outcome: 'found', ts }
      cursor = json.response_metadata?.next_cursor || ''
      if (!cursor) break
    }
    return { outcome: 'absent' }
  } catch (e: any) {
    // Timeout / network — we did not complete the search.
    return { outcome: 'unavailable', error: e?.message || String(e) }
  }
}

// ─── Ledger operations (compare-and-set, mirrors scavenger.claimCandidate) ────

/** Ensure a ledger row exists for (occurrence, recipient); return the current row. */
async function ensureDeliveryRow(opts: {
  meetingBriefingId: string
  recipient: BriefingRecipient
}): Promise<{ id: string; status: string; slack_channel_id: string | null }> {
  const sb = createAdminClient()
  // Insert-if-absent. onConflict on the unique (occurrence, recipient) key with
  // ignoreDuplicates so a concurrent creator doesn't error.
  await sb
    .from('meeting_briefing_deliveries')
    .upsert(
      {
        meeting_briefing_id: opts.meetingBriefingId,
        internal_recipient_id: opts.recipient.staff_id,
        slack_user_id: opts.recipient.slack_user_id,
        status: 'pending',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'meeting_briefing_id,internal_recipient_id', ignoreDuplicates: true },
    )
  const { data } = await sb
    .from('meeting_briefing_deliveries')
    .select('id, status, slack_channel_id')
    .eq('meeting_briefing_id', opts.meetingBriefingId)
    .eq('internal_recipient_id', opts.recipient.staff_id)
    .maybeSingle()
  return data
}

/**
 * Compare-and-set claim. Wins only if the row is not already terminal-sent and
 * either unclaimed/failed/unconfirmed OR its lease has expired (stale-claim
 * recovery). Returns true iff THIS caller won the claim. Mirrors
 * scavenger.ts `claimCandidate`.
 */
async function claimDelivery(opts: { id: string }): Promise<boolean> {
  const sb = createAdminClient()
  const now = new Date()
  const lease = new Date(now.getTime() + leaseMs())
  // Two CAS attempts: fresh states, then stale-lease reclaim. Kept as separate
  // predicates because supabase-js can't express the OR-with-timestamp cleanly.
  const fresh = await sb
    .from('meeting_briefing_deliveries')
    .update({
      status: 'claimed',
      claimed_at: now.toISOString(),
      lease_expires_at: lease.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', opts.id)
    .in('status', ['pending', 'failed', 'unconfirmed'])
    .select('id')
  if (fresh.error) throw new Error(`claimDelivery(fresh): ${fresh.error.message}`)
  if ((fresh.data?.length || 0) > 0) return true

  const stale = await sb
    .from('meeting_briefing_deliveries')
    .update({
      status: 'claimed',
      claimed_at: now.toISOString(),
      lease_expires_at: lease.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', opts.id)
    .in('status', ['claimed', 'posting'])
    .lt('lease_expires_at', now.toISOString())
    .select('id')
  if (stale.error) throw new Error(`claimDelivery(stale): ${stale.error.message}`)
  return (stale.data?.length || 0) > 0
}

async function markDelivery(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb
    .from('meeting_briefing_deliveries')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`markDelivery: ${error.message}`)
}

export type DeliveryOutcome =
  | { status: 'sent'; ts: string; reconciled?: boolean; already?: boolean }
  | { status: 'locked' }

export interface DeliveryLedgerRow {
  id: string
  status: string
  slack_channel_id: string | null
  slack_message_ts?: string | null
}

/**
 * The side-effecting operations the delivery state machine depends on. Injected
 * so the machine can be unit-tested against an in-memory ledger + a mock Slack
 * (no DB, no network). Production uses `makeDefaultDeps(token)`.
 */
export interface DeliveryDeps {
  ensureRow(meetingBriefingId: string, recipient: BriefingRecipient): Promise<DeliveryLedgerRow>
  claim(id: string): Promise<boolean>
  mark(id: string, patch: Record<string, unknown>): Promise<void>
  resolveChannel(recipient: BriefingRecipient): Promise<string>
  reconcile(channelId: string, deliveryId: string): Promise<ReconcileResult>
  post(
    channelId: string,
    text: string,
    deliveryId: string,
  ): Promise<ReturnType<typeof classifyPostOutcome>>
}

/** Production deps: Supabase ledger + Slack Web API. */
export function makeDefaultDeps(token: string): DeliveryDeps {
  return {
    ensureRow: (meetingBriefingId, recipient) =>
      ensureDeliveryRow({ meetingBriefingId, recipient }),
    claim: (id) => claimDelivery({ id }),
    mark: (id, patch) => markDelivery(id, patch),
    resolveChannel: (recipient) =>
      resolvePersonalBriefingChannel({
        slackUserId: recipient.slack_user_id,
        fullName: recipient.name,
        token,
      }),
    reconcile: (channelId, deliveryId) => reconcileDelivery({ token, channelId, deliveryId }),
    post: (channel, text, deliveryId) => postBriefingMessage({ token, channel, text, deliveryId }),
  }
}

/**
 * Deliver one briefing to one internal recipient, effectively-once.
 *
 * Idempotent by construction:
 *   - already 'sent'  → returns without posting.
 *   - concurrent live claim → returns 'locked' (the holder finishes).
 *   - prior attempt may have posted → reconcile via metadata before re-posting.
 *   - ambiguous/failed post → marks the ledger and THROWS so the Inngest step
 *     retries; the retry reconciles (finds the earlier post) instead of duping.
 *
 * MUST be called inside its own memoized Inngest step, so a 'sent' result is
 * cached and never re-executed when a sibling recipient's step retries.
 */
export async function deliverBriefingToRecipient(
  opts: {
    token: string
    meetingBriefingId: string
    recipient: BriefingRecipient
    text: string
  },
  deps: DeliveryDeps = makeDefaultDeps(opts.token),
): Promise<DeliveryOutcome> {
  const { meetingBriefingId, recipient, text } = opts
  if (!opts.token) throw new Error('SLACK_BOT_TOKEN not set')

  const row = await deps.ensureRow(meetingBriefingId, recipient)
  if (!row) throw new Error('could not create delivery ledger row')
  if (row.status === 'sent') {
    return { status: 'sent', ts: row.slack_message_ts || '', already: true }
  }

  const prevStatus = row.status
  const won = await deps.claim(row.id)
  if (!won) return { status: 'locked' }

  // Resolve the private per-person channel (needed for reconcile AND post).
  const channel = await deps.resolveChannel(recipient)

  // If a prior attempt might have posted, we MUST reconcile before posting —
  // this is a safety boundary, not an optimization.
  //   found       → already delivered; mark sent.
  //   absent      → confirmed not delivered; fall through and (re)post.
  //   unavailable → we cannot prove the state; NEVER repost. Stay 'unconfirmed'
  //                 and surface an operational error for an operator to resolve
  //                 (e.g. grant the groups:history scope, then it self-heals).
  if (shouldReconcile(prevStatus) || row.slack_channel_id) {
    const rec = await deps.reconcile(channel, row.id)
    if (rec.outcome === 'found') {
      await deps.mark(row.id, { status: 'sent', slack_message_ts: rec.ts, slack_channel_id: channel, error: null })
      return { status: 'sent', ts: rec.ts, reconciled: true }
    }
    if (rec.outcome === 'unavailable') {
      await deps.mark(row.id, {
        status: 'unconfirmed',
        slack_channel_id: channel,
        error: `reconciliation unavailable — not reposting: ${rec.error}`,
      })
      throw new Error(
        `briefing delivery unconfirmed and unreconcilable for ${recipient.slack_user_id} ` +
          `(needs groups:history scope or Slack recovered): ${rec.error}`,
      )
    }
    // rec.outcome === 'absent' → safe to (re)post below.
  }

  await deps.mark(row.id, { status: 'posting', slack_channel_id: channel })
  const outcome = await deps.post(channel, text, row.id)

  if (outcome.kind === 'ok') {
    await deps.mark(row.id, { status: 'sent', slack_message_ts: outcome.ts, slack_channel_id: channel, error: null })
    return { status: 'sent', ts: outcome.ts }
  }

  if (outcome.kind === 'ambiguous') {
    // Slack MAY have delivered. Leave 'unconfirmed' and throw so the Inngest
    // step retries and reconciles instead of re-posting blindly.
    await deps.mark(row.id, { status: 'unconfirmed', slack_channel_id: channel, error: outcome.error })
    throw new Error(`briefing delivery unconfirmed for ${recipient.slack_user_id}: ${outcome.error}`)
  }

  // Definitely not delivered — safe to re-post on the next retry.
  await deps.mark(row.id, { status: 'failed', error: outcome.error })
  throw new Error(`briefing delivery failed for ${recipient.slack_user_id}: ${outcome.error}`)
}
