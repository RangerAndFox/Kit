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

const SECRET = 'test-signing-secret-not-a-real-credential'
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

function forbidFetch() {
  globalThis.fetch = (async () => {
    throw new Error('side effect attempted: fetch called on a denial path')
  }) as typeof fetch
}

beforeEach(() => {
  warnings = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  process.env.SLACK_SIGNING_SECRET = SECRET
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.warn = realWarn
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
