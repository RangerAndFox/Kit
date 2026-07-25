/**
 * Route-level authorization tests for POST /api/webhooks/slack/commands.
 *
 * The route's only side effect is an outbound Slack `views.open` call made with
 * global fetch, so fetch is the injected port here: on every denial path it is
 * replaced with a stub that THROWS if called, which mechanically proves
 * verification completes before the side-effect boundary. No test touches
 * Supabase, Anthropic, Slack, or any other provider.
 *
 * Run: npx tsx --test src/app/api/webhooks/slack/commands/route.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { POST } from './route'

const SECRET = 'test-signing-secret-not-a-real-credential'
const BODY = 'text=newproject&trigger_id=T123.456&channel_id=C1'

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

function req(opts: { body?: string; ts?: string; sig?: string; omitHeaders?: boolean }): Request {
  const body = opts.body ?? BODY
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (!opts.omitHeaders) {
    headers['x-slack-request-timestamp'] = opts.ts ?? String(Math.floor(Date.now() / 1000))
    headers['x-slack-signature'] = opts.sig ?? sign(SECRET, opts.ts ?? String(Math.floor(Date.now() / 1000)), body)
  }
  return new Request('https://kit.example/api/webhooks/slack/commands', { method: 'POST', headers, body })
}

const realFetch = globalThis.fetch
const realWarn = console.warn
const realSecret = process.env.SLACK_SIGNING_SECRET
const realBotToken = process.env.SLACK_BOT_TOKEN

let warnings: string[] = []

/** Fetch port that fails the test if any side effect is attempted. */
function forbidFetch() {
  globalThis.fetch = (async () => {
    throw new Error('side effect attempted: fetch called on a denial path')
  }) as typeof fetch
}

beforeEach(() => {
  warnings = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  process.env.SLACK_SIGNING_SECRET = SECRET
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token'
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.warn = realWarn
  if (realSecret === undefined) delete process.env.SLACK_SIGNING_SECRET
  else process.env.SLACK_SIGNING_SECRET = realSecret
  if (realBotToken === undefined) delete process.env.SLACK_BOT_TOKEN
  else process.env.SLACK_BOT_TOKEN = realBotToken
})

describe('POST /api/webhooks/slack/commands — denial', () => {
  it('denies when SLACK_SIGNING_SECRET is absent, before any side effect', async () => {
    delete process.env.SLACK_SIGNING_SECRET
    forbidFetch()
    const res = await POST(req({}))
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'unauthorized' })
  })

  it('denies when SLACK_SIGNING_SECRET is empty/whitespace', async () => {
    process.env.SLACK_SIGNING_SECRET = '   '
    forbidFetch()
    const res = await POST(req({}))
    assert.equal(res.status, 401)
  })

  it('denies an absent signature', async () => {
    forbidFetch()
    const res = await POST(req({ omitHeaders: true }))
    assert.equal(res.status, 401)
  })

  it('denies an invalid signature', async () => {
    forbidFetch()
    const res = await POST(req({ sig: 'v0=deadbeef' }))
    assert.equal(res.status, 401)
  })

  it('denies a tampered body', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(
      req({ body: 'text=newproject&trigger_id=EVIL', ts, sig: sign(SECRET, ts, BODY) }),
    )
    assert.equal(res.status, 401)
  })

  it('denies a stale timestamp', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000) - 301)
    const res = await POST(req({ ts, sig: sign(SECRET, ts, BODY) }))
    assert.equal(res.status, 401)
  })

  it('denies a future timestamp beyond the window', async () => {
    forbidFetch()
    const ts = String(Math.floor(Date.now() / 1000) + 301)
    const res = await POST(req({ ts, sig: sign(SECRET, ts, BODY) }))
    assert.equal(res.status, 401)
  })

  it('returns a byte-identical body for misconfiguration and bad signature', async () => {
    forbidFetch()
    delete process.env.SLACK_SIGNING_SECRET
    const misconfigured = await POST(req({}))
    const misconfiguredBody = await misconfigured.text()

    process.env.SLACK_SIGNING_SECRET = SECRET
    const badSig = await POST(req({ sig: 'v0=deadbeef' }))
    const badSigBody = await badSig.text()

    assert.equal(misconfigured.status, badSig.status)
    assert.equal(misconfiguredBody, badSigBody)
  })
})

describe('POST /api/webhooks/slack/commands — denial logging', () => {
  it('logs the stable reason code and no secret material', async () => {
    delete process.env.SLACK_SIGNING_SECRET
    forbidFetch()
    const signature = sign(SECRET, String(Math.floor(Date.now() / 1000)), BODY)
    await POST(req({ sig: signature }))

    assert.equal(warnings.length, 1)
    const line = warnings[0]
    const parsed = JSON.parse(line)
    assert.equal(parsed.evt, 'slack_auth_denied')
    assert.equal(parsed.route, '/api/webhooks/slack/commands')
    assert.equal(parsed.reason, 'signing_secret_missing')
    assert.equal(parsed.signature_present, true)

    // No credential material anywhere in the log line.
    assert.ok(!line.includes(SECRET), 'log must not contain the signing secret')
    assert.ok(!line.includes(signature), 'log must not contain the signature')
    assert.ok(!line.includes('v0='), 'log must not contain signature material')
    assert.ok(!line.includes(BODY), 'log must not contain the raw body')
    assert.ok(!line.includes('xoxb-'), 'log must not contain a bot token')
  })

  it('logs invalid_signature as its own stable reason', async () => {
    forbidFetch()
    await POST(req({ sig: 'v0=deadbeef' }))
    assert.equal(JSON.parse(warnings[0]).reason, 'invalid_signature')
  })
})

describe('POST /api/webhooks/slack/commands — authorized behavior unchanged', () => {
  it('opens the modal for a validly signed newproject command', async () => {
    const calls: { url: string; method?: string }[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const res = await POST(req({}))

    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://slack.com/api/views.open')
    assert.equal(calls[0].method, 'POST')
  })

  it('still answers an unknown validly signed subcommand without a side effect', async () => {
    forbidFetch()
    const body = 'text=definitely-not-a-subcommand'
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ body, ts, sig: sign(SECRET, ts, body) }))
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.response_type, 'ephemeral')
  })
})
