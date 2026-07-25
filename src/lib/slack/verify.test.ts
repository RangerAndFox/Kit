/**
 * Slack request-signature verifier tests.
 *
 * Covers the absolute ±300s window in BOTH directions, tampering, and the
 * absent-header cases. No network, no provider access — the verifier is pure.
 *
 * Run: npx tsx --test src/lib/slack/verify.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from './verify'

const SECRET = 'test-signing-secret-not-a-real-credential'

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

describe('verifySlackSignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    const ts = String(nowSeconds())
    const body = 'token=x&text=newproject'
    assert.equal(verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body)), true)
  })

  it('rejects an absent signature', () => {
    const ts = String(nowSeconds())
    assert.equal(verifySlackSignature(SECRET, ts, 'body', ''), false)
  })

  it('rejects an absent timestamp', () => {
    assert.equal(verifySlackSignature(SECRET, '', 'body', sign(SECRET, '', 'body')), false)
  })

  it('rejects a non-numeric timestamp', () => {
    const body = 'body'
    assert.equal(verifySlackSignature(SECRET, 'not-a-number', body, sign(SECRET, 'not-a-number', body)), false)
  })

  it('rejects a tampered body (signature computed over different bytes)', () => {
    const ts = String(nowSeconds())
    const signature = sign(SECRET, ts, 'text=harmless')
    assert.equal(verifySlackSignature(SECRET, ts, 'text=tampered', signature), false)
  })

  it('rejects a valid signature made with the wrong secret', () => {
    const ts = String(nowSeconds())
    const body = 'body'
    assert.equal(verifySlackSignature(SECRET, ts, body, sign('other-secret', ts, body)), false)
  })

  it('rejects a stale timestamp beyond -300s', () => {
    const ts = String(nowSeconds() - 301)
    const body = 'body'
    assert.equal(verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body)), false)
  })

  it('accepts a timestamp just inside the -300s edge', () => {
    const ts = String(nowSeconds() - 299)
    const body = 'body'
    assert.equal(verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body)), true)
  })

  it('rejects a materially future-dated timestamp beyond +300s', () => {
    // This is the case the previous one-sided window accepted: re-signing a
    // captured body with a far-future ts made it replayable indefinitely.
    const ts = String(nowSeconds() + 301)
    const body = 'body'
    assert.equal(verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body)), false)
  })

  it('accepts a timestamp just inside the +300s edge (clock skew tolerance)', () => {
    const ts = String(nowSeconds() + 299)
    const body = 'body'
    assert.equal(verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body)), true)
  })

  it('rejects a malformed signature of differing length without throwing', () => {
    const ts = String(nowSeconds())
    assert.equal(verifySlackSignature(SECRET, ts, 'body', 'v0=short'), false)
  })
})
