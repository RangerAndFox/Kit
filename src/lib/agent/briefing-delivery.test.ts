// @ts-nocheck
/**
 * Delivery state-machine + reconciliation tests.
 *
 * Run: npx tsx --test src/lib/agent/briefing-delivery.test.ts
 *
 * The state machine is exercised against an in-memory ledger fake (mirroring the
 * SQL compare-and-set semantics of migration 055) and a mock Slack, so no DB or
 * network is needed. These prove the delivery guarantees the Oshi incident
 * required: a repeated workflow produces exactly one Slack message.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeliveryMetadata,
  findDeliveryTsInHistory,
  shouldReconcile,
  classifyPostOutcome,
  deliverBriefingToRecipient,
  type DeliveryDeps,
} from './briefing-delivery'

const RECIP = { staff_id: 'staff-1', slack_user_id: 'U1', email: 'a@rf.tv', name: 'Ann' }
const MB = 'mb-oshi'

// ── In-memory ledger + mock Slack, wired as DeliveryDeps ──────────────────────
function makeFakeDeps(cfg: {
  // one entry per post attempt, in order; missing → defaults to 'ok'.
  //   ambiguous      → Slack RECEIVED it but we timed out (recorded in history)
  //   ambiguous_lost → we timed out AND Slack never got it (NOT in history)
  postPlan?: ('ok' | 'ambiguous' | 'ambiguous_lost' | 'failed')[]
  // 'auto' → found if in history else absent; 'unavailable' → cannot determine
  reconcile?: 'auto' | 'unavailable'
} = {}): { deps: DeliveryDeps; state: any } {
  const plan = cfg.postPlan || []
  const state = {
    rows: new Map<string, any>(), // id -> row
    byKey: new Map<string, string>(), // `${mb}|${staff}` -> id
    history: [] as any[], // messages "delivered" to Slack
    posts: 0, // real post attempts that reached Slack
    idSeq: 0,
    tsSeq: 0,
  }
  const nowMs = () => 1_000_000 + state.tsSeq // monotonic enough for lease math

  const deps: DeliveryDeps = {
    async ensureRow(mbId, r) {
      const key = `${mbId}|${r.staff_id}`
      let id = state.byKey.get(key)
      if (!id) {
        id = `d${++state.idSeq}`
        state.byKey.set(key, id)
        state.rows.set(id, {
          id, status: 'pending', slack_channel_id: null, slack_message_ts: null,
          lease_expires_at: null,
        })
      }
      const row = state.rows.get(id)
      return { id: row.id, status: row.status, slack_channel_id: row.slack_channel_id, slack_message_ts: row.slack_message_ts }
    },
    async claim(id) {
      const r = state.rows.get(id)
      if (!r) return false
      const n = nowMs()
      const fresh = ['pending', 'failed', 'unconfirmed'].includes(r.status)
      const stale =
        ['claimed', 'posting'].includes(r.status) &&
        r.lease_expires_at != null && r.lease_expires_at < n
      if (fresh || stale) {
        r.status = 'claimed'
        r.lease_expires_at = n + 120_000
        return true
      }
      return false
    },
    async mark(id, patch) {
      Object.assign(state.rows.get(id), patch)
    },
    async resolveChannel() {
      return 'C-priv'
    },
    async reconcile(_channelId, deliveryId) {
      if (cfg.reconcile === 'unavailable') return { outcome: 'unavailable', error: 'missing_scope' }
      const ts = findDeliveryTsInHistory(state.history, deliveryId)
      return ts ? { outcome: 'found', ts } : { outcome: 'absent' }
    },
    async post(_channel, _text, deliveryId) {
      const kind = plan.length ? plan.shift()! : 'ok'
      state.posts++
      if (kind === 'ok' || kind === 'ambiguous') {
        // Both mean Slack RECEIVED the message (ambiguous = we just didn't get
        // the ack). Record it so a later reconcile can find it.
        const ts = `ts-${++state.tsSeq}`
        state.history.push({ ts, metadata: buildDeliveryMetadata(deliveryId) })
        if (kind === 'ok') return classifyPostOutcome({ ok: true, ts })
        return classifyPostOutcome({ threw: true, error: 'timeout' })
      }
      if (kind === 'ambiguous_lost') {
        // We timed out and Slack never received it — nothing recorded.
        return classifyPostOutcome({ threw: true, error: 'timeout' })
      }
      return classifyPostOutcome({ ok: false, error: 'channel_not_found' })
    },
  }
  return { deps, state }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('delivery pure helpers', () => {
  it('buildDeliveryMetadata carries an opaque delivery id', () => {
    const m = buildDeliveryMetadata('abc')
    assert.equal(m.event_type, 'kit_briefing_delivery')
    assert.equal(m.event_payload.delivery_id, 'abc')
  })

  it('findDeliveryTsInHistory matches only our metadata + id', () => {
    const hist = [
      { ts: 't1', metadata: { event_type: 'other', event_payload: { delivery_id: 'x' } } },
      { ts: 't2', metadata: buildDeliveryMetadata('x') },
    ]
    assert.equal(findDeliveryTsInHistory(hist, 'x'), 't2')
    assert.equal(findDeliveryTsInHistory(hist, 'y'), null)
    assert.equal(findDeliveryTsInHistory([], 'x'), null)
  })

  it('shouldReconcile is true only for non-fresh states', () => {
    assert.equal(shouldReconcile('unconfirmed'), true)
    assert.equal(shouldReconcile('claimed'), true)
    assert.equal(shouldReconcile('posting'), true)
    assert.equal(shouldReconcile('pending'), false)
    assert.equal(shouldReconcile('failed'), false)
    assert.equal(shouldReconcile(null), false)
  })

  it('classifyPostOutcome: throw→ambiguous, ok+ts→ok, ok:false→failed', () => {
    assert.equal(classifyPostOutcome({ threw: true, error: 'x' }).kind, 'ambiguous')
    assert.equal(classifyPostOutcome({ ok: true, ts: 't' }).kind, 'ok')
    assert.equal(classifyPostOutcome({ ok: false, error: 'e' }).kind, 'failed')
    assert.equal(classifyPostOutcome({ ok: true, ts: null }).kind, 'failed')
  })
})

// ── State machine ────────────────────────────────────────────────────────────
describe('deliverBriefingToRecipient', () => {
  const base = { token: 'xoxb-test', meetingBriefingId: MB, recipient: RECIP, text: 'hi' }

  it('OSHI REGRESSION: running the workflow twice produces exactly one Slack message', async () => {
    const { deps, state } = makeFakeDeps()
    const r1 = await deliverBriefingToRecipient(base, deps)
    const r2 = await deliverBriefingToRecipient(base, deps)
    assert.equal(r1.status, 'sent')
    assert.equal(r2.status, 'sent')
    assert.equal((r2 as any).already, true)
    assert.equal(state.posts, 1, 'second execution must not post again')
  })

  it('accepted-but-timeout: first send is ambiguous, retry reconciles — no duplicate', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ambiguous'] })
    // First attempt: Slack received it but we timed out → throws (Inngest retry).
    await assert.rejects(() => deliverBriefingToRecipient(base, deps), /unconfirmed/)
    assert.equal(state.rows.get('d1').status, 'unconfirmed')
    // Retry: reconciles via metadata, marks sent, does NOT post again.
    const r2 = await deliverBriefingToRecipient(base, deps)
    assert.equal(r2.status, 'sent')
    assert.equal((r2 as any).reconciled, true)
    assert.equal(state.posts, 1, 'reconciliation must not produce a second post')
  })

  it('SAFETY: reconciliation unavailable after ambiguous → stays unconfirmed, never reposts', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ambiguous'], reconcile: 'unavailable' })
    // First attempt: Slack may have received it; we timed out.
    await assert.rejects(() => deliverBriefingToRecipient(base, deps), /unconfirmed/)
    assert.equal(state.posts, 1)
    // Retry with reconciliation unavailable: MUST NOT repost; surfaces error.
    await assert.rejects(
      () => deliverBriefingToRecipient(base, deps),
      /unreconcilable|groups:history/,
    )
    // A further retry still refuses to repost.
    await assert.rejects(() => deliverBriefingToRecipient(base, deps), /unreconcilable|groups:history/)
    assert.equal(state.posts, 1, 'no second Slack post while reconciliation is unavailable')
    assert.equal(state.rows.get('d1').status, 'unconfirmed')
  })

  it('reconciliation confirms ABSENCE (message truly lost) → eligible for retry, one final post', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ambiguous_lost', 'ok'], reconcile: 'auto' })
    // First attempt timed out and Slack never got it.
    await assert.rejects(() => deliverBriefingToRecipient(base, deps), /unconfirmed/)
    assert.equal(state.posts, 1)
    // Retry: reconcile proves absence → safe to repost exactly once.
    const r = await deliverBriefingToRecipient(base, deps)
    assert.equal(r.status, 'sent')
    assert.equal(state.posts, 2)
  })

  it('crash-after-claim: an expired-lease claimed row is reclaimed and delivered once', async () => {
    const { deps, state } = makeFakeDeps()
    // Simulate a worker that claimed then crashed before posting: row 'claimed',
    // lease already expired.
    await deps.ensureRow(MB, RECIP)
    const id = state.byKey.get(`${MB}|${RECIP.staff_id}`)
    Object.assign(state.rows.get(id), { status: 'claimed', lease_expires_at: 1 /* long past */ })
    const r = await deliverBriefingToRecipient(base, deps)
    assert.equal(r.status, 'sent')
    assert.equal(state.posts, 1)
  })

  it('concurrent claim: a live claim held by another worker yields locked, no post', async () => {
    const { deps, state } = makeFakeDeps()
    // Another worker holds a live (unexpired) claim.
    await deps.ensureRow(MB, RECIP)
    const id = state.byKey.get(`${MB}|${RECIP.staff_id}`)
    Object.assign(state.rows.get(id), { status: 'claimed', lease_expires_at: 9_999_999_999 })
    const r = await deliverBriefingToRecipient(base, deps)
    assert.equal(r.status, 'locked')
    assert.equal(state.posts, 0)
  })

  it('recurring occurrences: two occurrences of the same series deliver independently', async () => {
    const { deps, state } = makeFakeDeps()
    // singleEvents:true gives each occurrence its own meeting_briefings row, so
    // the ledger key (occurrence, recipient) differs per instance.
    const a = await deliverBriefingToRecipient({ ...base, meetingBriefingId: 'mb-occ-1' }, deps)
    const b = await deliverBriefingToRecipient({ ...base, meetingBriefingId: 'mb-occ-2' }, deps)
    assert.equal(a.status, 'sent')
    assert.equal(b.status, 'sent')
    assert.equal(state.posts, 2, 'each occurrence gets its own single delivery')
    // But re-running occurrence 1 still does not duplicate.
    await deliverBriefingToRecipient({ ...base, meetingBriefingId: 'mb-occ-1' }, deps)
    assert.equal(state.posts, 2)
  })

  it('partial multi-recipient failure isolates recipients (ledger is per-recipient)', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ok', 'failed'] })
    const rOk = { staff_id: 's-ok', slack_user_id: 'U_OK', email: 'ok@rf.tv', name: 'Ok' }
    const rBad = { staff_id: 's-bad', slack_user_id: 'U_BAD', email: 'bad@rf.tv', name: 'Bad' }
    const okRes = await deliverBriefingToRecipient({ ...base, recipient: rOk }, deps)
    assert.equal(okRes.status, 'sent')
    await assert.rejects(() => deliverBriefingToRecipient({ ...base, recipient: rBad }, deps), /failed/)
    // The good recipient stays sent and is not re-posted on a later pass.
    const okAgain = await deliverBriefingToRecipient({ ...base, recipient: rOk }, deps)
    assert.equal((okAgain as any).already, true)
    assert.equal(state.posts, 2, 'one post for the good recipient, one failed attempt for the bad one')
  })
})
