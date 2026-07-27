/**
 * Route-level authorization tests for POST /api/webhooks/slack/events.
 *
 * Every side effect this route can reach — the Supabase workspace lookup, the
 * agent dispatch, Frame.io/Harvest handlers, chat.postMessage — is performed
 * over HTTP, so global fetch is the single injected port. On denial paths it is
 * replaced with a stub that THROWS if called, which mechanically proves
 * verification completes before the side-effect boundary (including before the
 * JSON parse that used to run first). No test touches a real provider.
 *
 * Run: npx tsx --test src/app/api/webhooks/slack/events/route.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { POST } from './route'
import {
  __setSlackEventPortsForTests,
  type SlackScheduledWork,
  type WorkspaceBindingLookup,
} from '@/lib/slack/events-workspace'

const SECRET = 'test-signing-secret-not-a-real-credential'
const BOUND_WORKSPACE = '11111111-2222-3333-4444-555555555555'
const OTHER_WORKSPACE = '99999999-8888-7777-6666-555555555555'
const CHALLENGE_BODY = JSON.stringify({ type: 'url_verification', challenge: 'abc123challenge' })
const EVENT_BODY = JSON.stringify({
  type: 'event_callback',
  team_id: 'T4ATY2XAL',
  event: { type: 'app_mention', text: 'hi kit', channel: 'C1', ts: '1.1', user: 'U1' },
})

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

function req(opts: { body?: string; ts?: string; sig?: string; omitHeaders?: boolean }): Request {
  const body = opts.body ?? EVENT_BODY
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!opts.omitHeaders) {
    headers['x-slack-request-timestamp'] = ts
    headers['x-slack-signature'] = opts.sig ?? sign(SECRET, ts, body)
  }
  return new Request('https://kit.example/api/webhooks/slack/events', { method: 'POST', headers, body })
}

const realFetch = globalThis.fetch
const realWarn = console.warn
const realSecret = process.env.SLACK_SIGNING_SECRET

let warnings: string[] = []
let lookupCalls: string[] = []
let scheduled: SlackScheduledWork[] = []

function forbidFetch() {
  globalThis.fetch = (async () => {
    throw new Error('side effect attempted: fetch called on a denial path')
  }) as typeof fetch
}

/**
 * Install fake ports. The lookup records its calls rather than throwing when it
 * must not be reached — `resolveBoundWorkspace` catches throws by design, so a
 * throwing fake would be silently swallowed and the assertion would pass for the
 * wrong reason. Scheduling is captured, never executed.
 */
function setPorts(lookup: WorkspaceBindingLookup) {
  __setSlackEventPortsForTests({
    lookup: async (teamId) => {
      lookupCalls.push(teamId)
      return lookup(teamId)
    },
    scheduler: (work) => { scheduled.push(work) },
  })
}

const noBinding: WorkspaceBindingLookup = async () => ({ ids: [] })

beforeEach(() => {
  warnings = []
  lookupCalls = []
  scheduled = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  process.env.SLACK_SIGNING_SECRET = SECRET
  setPorts(noBinding)
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.warn = realWarn
  __setSlackEventPortsForTests(null)
  if (realSecret === undefined) delete process.env.SLACK_SIGNING_SECRET
  else process.env.SLACK_SIGNING_SECRET = realSecret
})

describe('POST /api/webhooks/slack/events — denial', () => {
  it('denies when SLACK_SIGNING_SECRET is absent, before any side effect', async () => {
    delete process.env.SLACK_SIGNING_SECRET
    forbidFetch()
    const res = await POST(req({}))
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'unauthorized' })
  })

  it('denies when SLACK_SIGNING_SECRET is empty/whitespace', async () => {
    process.env.SLACK_SIGNING_SECRET = ''
    forbidFetch()
    assert.equal((await POST(req({}))).status, 401)
  })

  it('denies an absent signature', async () => {
    forbidFetch()
    assert.equal((await POST(req({ omitHeaders: true }))).status, 401)
  })

  it('denies an invalid signature', async () => {
    forbidFetch()
    assert.equal((await POST(req({ sig: 'v0=deadbeef' }))).status, 401)
  })

  it('denies a tampered body', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000))
    const tampered = JSON.stringify({ type: 'event_callback', team_id: 'T-EVIL', event: { type: 'app_mention' } })
    assert.equal((await POST(req({ body: tampered, ts, sig: sign(SECRET, ts, EVENT_BODY) }))).status, 401)
  })

  it('denies a stale timestamp', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000) - 301)
    assert.equal((await POST(req({ ts, sig: sign(SECRET, ts, EVENT_BODY) }))).status, 401)
  })

  it('denies a future timestamp beyond the window', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000) + 301)
    assert.equal((await POST(req({ ts, sig: sign(SECRET, ts, EVENT_BODY) }))).status, 401)
  })

  it('denies unsigned malformed JSON without reporting a parse error', async () => {
    // Proves verification precedes semantic parsing: the old ordering answered
    // 400 "Invalid JSON" to an unauthenticated caller.
    forbidFetch()
    delete process.env.SLACK_SIGNING_SECRET
    const res = await POST(
      new Request('https://kit.example/api/webhooks/slack/events', { method: 'POST', body: '{not json' }),
    )
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'unauthorized' })
  })

  it('returns a byte-identical body for misconfiguration and bad signature', async () => {
    forbidFetch()
    delete process.env.SLACK_SIGNING_SECRET
    const a = await POST(req({}))
    const aBody = await a.text()
    process.env.SLACK_SIGNING_SECRET = SECRET
    const b = await POST(req({ sig: 'v0=deadbeef' }))
    const bBody = await b.text()
    assert.equal(a.status, b.status)
    assert.equal(aBody, bBody)
  })
})

describe('POST /api/webhooks/slack/events — denial logging', () => {
  it('logs the stable reason code and no secret material', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000))
    const signature = sign(SECRET, ts, EVENT_BODY)
    await POST(req({ ts, sig: 'v0=deadbeef' }))

    assert.equal(warnings.length, 1)
    const line = warnings[0]
    const parsed = JSON.parse(line)
    assert.equal(parsed.evt, 'slack_auth_denied')
    assert.equal(parsed.route, '/api/webhooks/slack/events')
    assert.equal(parsed.reason, 'invalid_signature')
    assert.ok(!line.includes(SECRET), 'log must not contain the signing secret')
    assert.ok(!line.includes(signature), 'log must not contain a valid signature')
    assert.ok(!line.includes(EVENT_BODY), 'log must not contain the raw body')
  })
})

describe('POST /api/webhooks/slack/events — authorized behavior unchanged', () => {
  it('answers a validly signed url_verification challenge', async () => {
    // The challenge is signed by Slack, so it needs no pre-verification
    // exemption — and it reaches no provider, so fetch stays forbidden.
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ body: CHALLENGE_BODY, ts, sig: sign(SECRET, ts, CHALLENGE_BODY) }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { challenge: 'abc123challenge' })
  })

  it('still ignores a validly signed bot message without dispatching', async () => {
    forbidFetch()
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T4ATY2XAL',
      event: { type: 'message', bot_id: 'B1', text: 'from a bot' },
    })
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ body, ts, sig: sign(SECRET, ts, body) }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, ignored: 'bot_message' })
  })

  it('still ignores a validly signed irrelevant event type', async () => {
    forbidFetch()
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T4ATY2XAL',
      event: { type: 'reaction_added' },
    })
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ body, ts, sig: sign(SECRET, ts, body) }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, ignored: 'reaction_added' })
  })
})

// ─── Workspace binding ───────────────────────────────────────────────────────
// A valid Slack signature proves Slack sent the request; it does not authorize
// the sending team to act in a Kit workspace. These tests prove the scheduling
// boundary is unreachable without an exact workspaces.slack_team_id binding —
// the fetch stub covers provider calls, and the captured scheduler covers
// after(), which the fetch stub alone could not prove.

function signedEvent(opts: { teamId?: string | null; eventType?: string } = {}): Request {
  const event = { type: opts.eventType ?? 'app_mention', text: 'hi kit', channel: 'C1', ts: '1.1', user: 'U1' }
  const payload: Record<string, unknown> = { type: 'event_callback', event }
  if (opts.teamId !== null) payload.team_id = opts.teamId ?? 'T4ATY2XAL'
  const body = JSON.stringify(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  return req({ body, ts, sig: sign(SECRET, ts, body) })
}

const UNBOUND_ACK = { ok: true, ignored: 'workspace_unbound' }

describe('POST /api/webhooks/slack/events — workspace binding is required', () => {
  it('a signed relevant event with no team_id is acknowledged and schedules nothing', async () => {
    forbidFetch()
    const res = await POST(signedEvent({ teamId: null }))

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), UNBOUND_ACK)
    assert.equal(scheduled.length, 0, 'nothing may be scheduled')
    assert.equal(lookupCalls.length, 0, 'no binding lookup for an absent team_id')

    const log = JSON.parse(warnings.at(-1) as string)
    assert.equal(log.evt, 'slack_workspace_unbound')
    assert.equal(log.route, '/api/webhooks/slack/events')
    assert.equal(log.reason, 'team_id_missing')
    assert.equal(log.team_id_present, false)
  })

  it('a signed relevant event from an unbound team schedules, dispatches, and posts nothing', async () => {
    forbidFetch()
    setPorts(noBinding)
    const res = await POST(signedEvent({ teamId: 'T-UNBOUND' }))

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), UNBOUND_ACK)
    assert.equal(scheduled.length, 0)
    assert.deepEqual(lookupCalls, ['T-UNBOUND'], 'exactly one exact-binding lookup, no second query')
    assert.equal(JSON.parse(warnings.at(-1) as string).reason, 'workspace_binding_not_found')
  })

  it('a failed workspace lookup is acknowledged without exposing the database error', async () => {
    forbidFetch()
    const dbError = 'permission denied for relation workspaces'
    setPorts(async () => { throw new Error(dbError) })

    const res = await POST(signedEvent({}))
    const bodyText = await res.text()

    assert.equal(res.status, 200)
    assert.equal(bodyText, JSON.stringify(UNBOUND_ACK))
    assert.ok(!bodyText.includes(dbError), 'response must not expose the database error')
    assert.equal(scheduled.length, 0)

    const line = warnings.at(-1) as string
    assert.equal(JSON.parse(line).reason, 'workspace_binding_lookup_failed')
    assert.ok(!line.includes(dbError), 'log must not contain database error text')
  })

  it('an ambiguous binding (more than one workspace) is refused, not chosen between', async () => {
    forbidFetch()
    setPorts(async () => ({ ids: [BOUND_WORKSPACE, OTHER_WORKSPACE] }))

    const res = await POST(signedEvent({}))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), UNBOUND_ACK)
    assert.equal(scheduled.length, 0)
    assert.equal(JSON.parse(warnings.at(-1) as string).reason, 'workspace_binding_lookup_failed')
  })

  it('returns an identical external acknowledgement for every internal reason', async () => {
    forbidFetch()
    const bodies: string[] = []

    setPorts(noBinding)
    bodies.push(await (await POST(signedEvent({ teamId: null }))).text())
    bodies.push(await (await POST(signedEvent({ teamId: 'T-UNBOUND' }))).text())
    setPorts(async () => { throw new Error('boom') })
    bodies.push(await (await POST(signedEvent({}))).text())

    assert.equal(new Set(bodies).size, 1, 'all denial reasons must look identical externally')
  })

  it('a bound team reaches the scheduling boundary exactly once with its own workspace id', async () => {
    // fetch stays forbidden: the scheduled work is captured, never executed, so
    // no provider is contacted while still proving what was scheduled.
    forbidFetch()
    setPorts(async (teamId) => ({ ids: teamId === 'T-BOUND' ? [BOUND_WORKSPACE] : [] }))

    const event = { type: 'app_mention', text: 'hi kit', channel: 'C1', ts: '1.1', user: 'U1' }
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T-BOUND', event })
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ body, ts, sig: sign(SECRET, ts, body) }))

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(scheduled.length, 1, 'scheduled exactly once')
    assert.equal(scheduled[0].workspaceId, BOUND_WORKSPACE, 'the resolved binding, never a default')
    assert.notEqual(scheduled[0].workspaceId, OTHER_WORKSPACE)
    assert.equal(typeof scheduled[0].run, 'function')
    assert.equal(warnings.length, 0, 'an authorized event logs no denial')
  })

  it('does not resolve a workspace for events filtered out before the binding check', async () => {
    forbidFetch()
    const botBody = JSON.stringify({
      type: 'event_callback',
      team_id: 'T-BOUND',
      event: { type: 'message', bot_id: 'B1', text: 'from a bot' },
    })
    const ts = String(Math.floor(Date.now() / 1000))
    await POST(req({ body: botBody, ts, sig: sign(SECRET, ts, botBody) }))

    assert.equal(lookupCalls.length, 0, 'irrelevant events must not query the binding')
    assert.equal(scheduled.length, 0)
  })
})
