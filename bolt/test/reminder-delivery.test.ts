import { describe, it, expect } from 'vitest'

import {
  reminderWindowPhase,
  resolveLocalHour,
  buildReminderMetadata,
  findReminderTsInHistory,
  shouldReconcile,
  classifyPostOutcome,
  buildReminderDiagnostic,
  deliverHoursReminder,
  sweepDailyReminders,
  dueHour,
  cutoffHour,
  type ReminderDeps,
  type ReminderStaff,
} from '../src/checkins/reminder-delivery'
import { isWorkday } from '../src/checkins/date'

const STAFF: ReminderStaff = {
  id: 'staff-steve',
  slack_user_id: 'U4CA7HXT9',
  full_name: 'Steve Ranger',
  harvest_user_id: 5634070,
}
const DATE = '2026-07-31' // Friday
const PERSONAL = 'C-personal-kit' // the private one-person Kit channel

// ── In-memory ledger + mock Slack, mirroring migration 064's SQL semantics ────
function makeFakeDeps(cfg: {
  postPlan?: ('ok' | 'ambiguous' | 'ambiguous_lost' | 'failed')[]
  reconcile?: 'auto' | 'unavailable'
  satisfied?: boolean
} = {}) {
  const plan = cfg.postPlan || []
  const state = {
    rows: new Map<string, any>(),
    byKey: new Map<string, string>(), // `${staffId}|${localDate}` -> id
    history: [] as any[],
    conversations: [] as any[],
    posts: 0,
    channelsUsedForPost: [] as string[],
    openedDMs: 0, // must stay 0 — reminders never use the Assistant DM
    idSeq: 0,
    ciSeq: 0,
    tsSeq: 0,
  }
  const nowMs = () => 1_000_000 + state.tsSeq

  const deps: ReminderDeps = {
    async ensureRow(staff, localDate) {
      const key = `${staff.id}|${localDate}`
      let id = state.byKey.get(key)
      if (!id) {
        id = `r${++state.idSeq}`
        state.byKey.set(key, id)
        state.rows.set(id, {
          id, status: 'pending', slack_channel_id: null, slack_message_ts: null,
          lease_expires_at: null,
        })
      }
      const r = state.rows.get(id)
      return { id: r.id, status: r.status, slack_channel_id: r.slack_channel_id, slack_message_ts: r.slack_message_ts }
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
    async isSatisfied() {
      return !!cfg.satisfied
    },
    async resolveChannel() {
      return PERSONAL
    },
    async reconcile(_channelId, reminderId) {
      if (cfg.reconcile === 'unavailable') return { outcome: 'unavailable', error: 'missing_scope' }
      const ts = findReminderTsInHistory(state.history, reminderId)
      return ts ? { outcome: 'found', ts } : { outcome: 'absent' }
    },
    async post(channel, _text, reminderId) {
      const kind = plan.length ? plan.shift()! : 'ok'
      state.posts++
      state.channelsUsedForPost.push(channel)
      if (kind === 'ok' || kind === 'ambiguous') {
        const ts = `ts-${++state.tsSeq}`
        state.history.push({ ts, metadata: buildReminderMetadata(reminderId) })
        if (kind === 'ok') return classifyPostOutcome({ ok: true, ts })
        return classifyPostOutcome({ threw: true, error: 'timeout' })
      }
      if (kind === 'ambiguous_lost') {
        return classifyPostOutcome({ threw: true, error: 'timeout' })
      }
      return classifyPostOutcome({ ok: false, error: 'channel_not_found' })
    },
    async recordConversation({ staff, localDate, channelId, ts }) {
      const key = `${staff.id}|${localDate}`
      const existing = state.conversations.find((c) => c.key === key)
      if (existing) return existing.id
      const id = `ci-${++state.ciSeq}`
      state.conversations.push({ id, key, dm_channel_id: channelId, dm_ts: ts, status: 'sent', origin: 'scheduled' })
      return id
    },
  }
  return { deps, state }
}

const base = { staff: STAFF, localDate: DATE, tz: 'America/New_York', text: 'hours check-in' }

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('pure helpers', () => {
  it('reminderWindowPhase: before < due <= window < cutoff <= after', () => {
    expect(reminderWindowPhase(16, 17, 21)).toBe('before')
    expect(reminderWindowPhase(17, 17, 21)).toBe('window') // (1) becomes due at 5pm
    expect(reminderWindowPhase(18, 17, 21)).toBe('window') // (2) 6pm still in window
    expect(reminderWindowPhase(20, 17, 21)).toBe('window')
    expect(reminderWindowPhase(21, 17, 21)).toBe('after') // (8) cutoff → never post
    expect(reminderWindowPhase(23, 17, 21)).toBe('after')
  })

  it('config defaults: due 17, cutoff 21 (cutoff always > due)', () => {
    expect(dueHour()).toBe(17)
    expect(cutoffHour()).toBe(21)
    expect(cutoffHour()).toBeGreaterThan(dueHour())
  })

  it('resolveLocalHour tracks tz + DST', () => {
    const t = new Date('2026-07-31T21:00:00Z') // 5pm EDT, 2pm PDT
    expect(resolveLocalHour(t, 'America/New_York')).toBe(17)
    expect(resolveLocalHour(t, 'America/Los_Angeles')).toBe(14)
  })

  it('findReminderTsInHistory matches only our metadata + id', () => {
    const hist = [
      { ts: 't1', metadata: { event_type: 'other', event_payload: { reminder_id: 'x' } } },
      { ts: 't2', metadata: buildReminderMetadata('x') },
    ]
    expect(findReminderTsInHistory(hist, 'x')).toBe('t2')
    expect(findReminderTsInHistory(hist, 'y')).toBe(null)
  })

  it('shouldReconcile true only for non-fresh states', () => {
    expect(shouldReconcile('unconfirmed')).toBe(true)
    expect(shouldReconcile('claimed')).toBe(true)
    expect(shouldReconcile('posting')).toBe(true)
    expect(shouldReconcile('pending')).toBe(false)
    expect(shouldReconcile('failed')).toBe(false)
    expect(shouldReconcile(null)).toBe(false)
  })

  it('classifyPostOutcome: throw→ambiguous, ok+ts→ok, ok:false→failed', () => {
    expect(classifyPostOutcome({ threw: true, error: 'x' }).kind).toBe('ambiguous')
    expect(classifyPostOutcome({ ok: true, ts: 't' }).kind).toBe('ok')
    expect(classifyPostOutcome({ ok: false, error: 'e' }).kind).toBe('failed')
    expect(classifyPostOutcome({ ok: true, ts: null }).kind).toBe('failed')
  })
})

// ── Weekend / holiday (14) ────────────────────────────────────────────────────
describe('workday gating', () => {
  it('skips weekends and studio holidays', () => {
    expect(isWorkday('2026-08-01', 'America/New_York')).toBe(false) // Saturday
    expect(isWorkday('2026-08-02', 'America/New_York')).toBe(false) // Sunday
    // 2026-07-04 (Independence Day) is a Saturday → observed Friday 2026-07-03.
    expect(isWorkday('2026-07-03', 'America/New_York')).toBe(false)
    expect(isWorkday('2026-07-31', 'America/New_York')).toBe(true) // Friday
  })
})

// ── Delivery state machine ────────────────────────────────────────────────────
describe('deliverHoursReminder', () => {
  it('(1)(9) becomes due, delivers once; re-run posts nothing', async () => {
    const { deps, state } = makeFakeDeps()
    const r1 = await deliverHoursReminder(base, deps)
    const r2 = await deliverHoursReminder(base, deps)
    expect(r1.status).toBe('sent')
    expect(r2.status).toBe('sent')
    expect((r2 as any).already).toBe(true)
    expect(state.posts).toBe(1)
  })

  it('(10) delivers to the private Kit channel, never the Assistant DM', async () => {
    const { deps, state } = makeFakeDeps()
    const r = await deliverHoursReminder(base, deps)
    expect(r.status).toBe('sent')
    expect(state.channelsUsedForPost).toEqual([PERSONAL])
    expect(state.openedDMs).toBe(0)
    // The occurrence and the conversation row both point at the Kit channel.
    const row = state.rows.get(state.byKey.get(`${STAFF.id}|${DATE}`)!)
    expect(row.slack_channel_id).toBe(PERSONAL)
    expect(state.conversations[0].dm_channel_id).toBe(PERSONAL)
  })

  it('(18) records a reply-compatible scheduled check-in row on send', async () => {
    const { deps, state } = makeFakeDeps()
    await deliverHoursReminder(base, deps)
    const ci = state.conversations[0]
    expect(ci.status).toBe('sent')
    expect(ci.origin).toBe('scheduled') // findOpenCheckin looks for sent/nudged
    expect(ci.dm_ts).toBeTruthy()
    const row = state.rows.get(state.byKey.get(`${STAFF.id}|${DATE}`)!)
    expect(row.check_in_id).toBe(ci.id)
  })

  it('(3) restart after occurrence created but before posting → delivered once', async () => {
    const { deps, state } = makeFakeDeps()
    await deps.ensureRow(STAFF, DATE, base.tz) // occurrence exists, pending
    const r = await deliverHoursReminder(base, deps)
    expect(r.status).toBe('sent')
    expect(state.posts).toBe(1)
  })

  it('(4) crash after Slack accepted but before mark sent → reconciles, no repost', async () => {
    const { deps, state } = makeFakeDeps()
    await deps.ensureRow(STAFF, DATE, base.tz)
    const id = state.byKey.get(`${STAFF.id}|${DATE}`)!
    // Simulate: posted (in history) but process died mid-'posting', lease expired.
    Object.assign(state.rows.get(id), { status: 'posting', slack_channel_id: PERSONAL, lease_expires_at: 1 })
    state.history.push({ ts: 'ts-precrash', metadata: buildReminderMetadata(id) })
    const r = await deliverHoursReminder(base, deps)
    expect(r.status).toBe('sent')
    expect((r as any).reconciled).toBe(true)
    expect(state.posts).toBe(0) // never reposted
  })

  it('(5) ambiguous post, reconcile finds it → no duplicate', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ambiguous'] })
    const r1 = await deliverHoursReminder(base, deps)
    expect(r1.status).toBe('unconfirmed')
    const r2 = await deliverHoursReminder(base, deps)
    expect(r2.status).toBe('sent')
    expect((r2 as any).reconciled).toBe(true)
    expect(state.posts).toBe(1)
  })

  it('(6) reconcile proves absence → exactly one safe repost', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ambiguous_lost', 'ok'], reconcile: 'auto' })
    const r1 = await deliverHoursReminder(base, deps)
    expect(r1.status).toBe('unconfirmed')
    expect(state.posts).toBe(1)
    const r2 = await deliverHoursReminder(base, deps)
    expect(r2.status).toBe('sent')
    expect(state.posts).toBe(2)
  })

  it('(7) reconcile unavailable → never reposts, stays unconfirmed', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['ambiguous'], reconcile: 'unavailable' })
    const r1 = await deliverHoursReminder(base, deps)
    expect(r1.status).toBe('unconfirmed')
    expect(state.posts).toBe(1)
    const r2 = await deliverHoursReminder(base, deps)
    expect(r2.status).toBe('unconfirmed')
    const r3 = await deliverHoursReminder(base, deps)
    expect(r3.status).toBe('unconfirmed')
    expect(state.posts).toBe(1) // no repost while reconciliation is unavailable
  })

  it('(8)(20) concurrent live claim yields locked, no post', async () => {
    const { deps, state } = makeFakeDeps()
    await deps.ensureRow(STAFF, DATE, base.tz)
    const id = state.byKey.get(`${STAFF.id}|${DATE}`)!
    Object.assign(state.rows.get(id), { status: 'claimed', lease_expires_at: 9_999_999_999 })
    const r = await deliverHoursReminder(base, deps)
    expect(r.status).toBe('locked')
    expect(state.posts).toBe(0)
  })

  it('(12)(13) one occurrence per local workday even across a tz change', async () => {
    const { deps, state } = makeFakeDeps()
    // Same recipient + same local_date, evaluated once as Eastern and once as
    // Pacific (travel). The occurrence is keyed by (staff, local_date), so the
    // second delivery finds the same row — no duplicate.
    const a = await deliverHoursReminder({ ...base, tz: 'America/New_York' }, deps)
    const b = await deliverHoursReminder({ ...base, tz: 'America/Los_Angeles' }, deps)
    expect(a.status).toBe('sent')
    expect((b as any).already).toBe(true)
    expect(state.posts).toBe(1)
    expect(state.byKey.size).toBe(1)
  })

  it('(17) an existing/ad-hoc logged entry satisfies → skipped, no post', async () => {
    const { deps, state } = makeFakeDeps({ satisfied: true })
    const r = await deliverHoursReminder(base, deps)
    expect(r.status).toBe('skipped')
    expect((r as any).reason).toBe('satisfied_existing')
    expect(state.posts).toBe(0)
  })

  it('(15) missing Harvest mapping → durable failed reason, no post', async () => {
    const { deps, state } = makeFakeDeps()
    const r = await deliverHoursReminder(
      { ...base, staff: { ...STAFF, harvest_user_id: null } },
      deps,
    )
    expect(r.status).toBe('failed')
    expect((r as any).reason).toBe('no_harvest_mapping')
    const row = state.rows.get(state.byKey.get(`${STAFF.id}|${DATE}`)!)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('no_harvest_mapping')
    expect(state.posts).toBe(0)
  })

  it('a definitive Slack failure is retryable on the next sweep', async () => {
    const { deps, state } = makeFakeDeps({ postPlan: ['failed', 'ok'] })
    const r1 = await deliverHoursReminder(base, deps)
    expect(r1.status).toBe('failed')
    const r2 = await deliverHoursReminder(base, deps) // 'failed' is a fresh claim state
    expect(r2.status).toBe('sent')
    expect(state.posts).toBe(2)
  })
})

// ── Sweep (2, 8-at-sweep, 11, 14, 16, cutoff, tz cohorts) ─────────────────────
describe('sweepDailyReminders', () => {
  const app: any = {}
  const staff2: ReminderStaff = { id: 'staff-pac', slack_user_id: 'UPAC', full_name: 'Pat West', harvest_user_id: 42 }

  function harness(overrides: Partial<Parameters<typeof sweepDailyReminders>[1]> = {}) {
    const { deps, state } = makeFakeDeps()
    const expired: string[] = []
    const opts = {
      deps,
      loadStaff: async () => [STAFF, staff2],
      resolveTz: async (u: string) => (u === 'UPAC' ? 'America/Los_Angeles' : 'America/New_York'),
      expire: async (staffId: string, localDate: string) => {
        expired.push(`${staffId}|${localDate}`)
        return true
      },
      ...overrides,
    }
    return { deps, state, expired, opts }
  }

  it('(11) delivers to whoever is at 5pm local; others are not due', async () => {
    // 21:00 UTC = 5pm EDT (Steve due), 2pm PDT (Pat not due).
    const { state, opts } = harness()
    const tally = await sweepDailyReminders(app, { ...opts, now: new Date('2026-07-31T21:00:00Z') })
    expect(tally.sent).toBe(1)
    expect(tally.notDue).toBe(1)
    expect(state.posts).toBe(1)
  })

  it('(2) a sweep at 6pm local still delivers (catch-up after a missed 5pm)', async () => {
    // 22:00 UTC = 6pm EDT.
    const { state, opts } = harness()
    const tally = await sweepDailyReminders(app, { ...opts, now: new Date('2026-07-31T22:00:00Z') })
    expect(tally.sent).toBe(1)
    expect(state.posts).toBe(1)
  })

  it('(cutoff) past the cutoff, unresolved occurrence is expired, not posted', async () => {
    // 01:30 UTC Aug 1 = 9:30pm EDT Fri (after 9pm cutoff). Scoped to one Eastern
    // recipient so the assertion isn't muddied by the Pacific staffer (still in
    // window an hour behind).
    const { state, expired, opts } = harness({
      loadStaff: async () => [STAFF],
      resolveTz: async () => 'America/New_York',
    })
    const tally = await sweepDailyReminders(app, { ...opts, now: new Date('2026-08-01T01:30:00Z') })
    expect(tally.expired).toBe(1)
    expect(state.posts).toBe(0)
    expect(expired).toContain(`${STAFF.id}|2026-07-31`)
  })

  it('(14) weekend is skipped for everyone', async () => {
    // Saturday 2026-08-01, 21:00 UTC = 5pm EDT / 2pm PDT — Saturday in BOTH tzs.
    const { state, opts } = harness()
    const tally = await sweepDailyReminders(app, { ...opts, now: new Date('2026-08-01T21:00:00Z') })
    expect(tally.notWorkday).toBe(2) // both recipients: Saturday, not a workday
    expect(tally.notDue).toBe(0)
    expect(state.posts).toBe(0)
  })

  it('(16) inactive / opted-out staff never reach delivery (loader filters them)', async () => {
    // The default loader filters daily_checkin+is_active; here we prove the sweep
    // only ever delivers to whom loadStaff returns.
    const { state, opts } = harness({ loadStaff: async () => [] })
    const tally = await sweepDailyReminders(app, { ...opts, now: new Date('2026-07-31T21:00:00Z') })
    expect(tally.sent).toBe(0)
    expect(state.posts).toBe(0)
  })

  it('(8) two overlapping sweeps at the same instant → one delivery', async () => {
    const { deps, state } = makeFakeDeps()
    const opts = {
      deps, // shared ledger across both sweeps
      loadStaff: async () => [STAFF],
      resolveTz: async () => 'America/New_York',
      expire: async () => false,
      now: new Date('2026-07-31T21:00:00Z'),
    }
    const [t1, t2] = await Promise.all([
      sweepDailyReminders(app, opts),
      sweepDailyReminders(app, opts),
    ])
    expect(t1.sent + t2.sent).toBe(1)
    expect(state.posts).toBe(1)
  })
})

// ── Diagnostic (19) ───────────────────────────────────────────────────────────
describe('buildReminderDiagnostic', () => {
  it('is read-only and secret-safe (no token, no message body)', () => {
    const d = buildReminderDiagnostic({
      slackUserId: 'U4CA7HXT9',
      localDate: DATE,
      staff: { daily_checkin: true, is_active: true, harvest_user_id: 5634070 },
      tz: 'America/New_York',
      localHour: 17,
      occurrence: {
        status: 'sent', skip_reason: null, error: null, attempts: 1,
        slack_channel_id: PERSONAL, slack_message_ts: 'ts-9', check_in_id: 'ci-1',
        claimed_at: 't', lease_expires_at: 't',
      },
      checkIn: { status: 'sent', origin: 'scheduled' },
    })
    const json = JSON.stringify(d)
    expect(json).not.toMatch(/xoxb|token|secret/i)
    // ts existence is a boolean, not the raw ts, and no message text is present.
    expect(d.occurrence!.has_message_ts).toBe(true)
    expect(json).not.toContain('ts-9')
    expect(d.eligibility.window_phase).toBe('window')
    expect(d.occurrence!.status).toBe('sent')
  })

  it('surfaces the eligibility failures an operator needs', () => {
    const d = buildReminderDiagnostic({
      slackUserId: 'UX',
      localDate: DATE,
      staff: { daily_checkin: false, is_active: true, harvest_user_id: null },
      tz: 'America/New_York',
      localHour: 12,
      occurrence: null,
      checkIn: null,
    })
    expect(d.eligibility.has_harvest_mapping).toBe(false)
    expect(d.notes.join(' ')).toMatch(/daily_checkin is off/)
    expect(d.notes.join(' ')).toMatch(/no Harvest mapping/)
    expect(d.notes.join(' ')).toMatch(/no occurrence row/)
  })
})
