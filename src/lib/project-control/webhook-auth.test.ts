/**
 * Sheet-edit webhook authentication + one-event dispatch.
 *
 * Proves the security contract mechanically: every denial path authorizes
 * nothing and sends nothing; only a valid, correctly-signed notification for the
 * configured workbook sends EXACTLY ONE named event carrying the dedupe id.
 *
 * Run: npx tsx --test src/lib/project-control/webhook-auth.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  authorizeSheetEditWebhook,
  handleSheetEditNotification,
  verifyWebhookSignature,
  sheetEditEvent,
  SHEET_EDITED_EVENT,
  MAX_TIMESTAMP_SKEW_MS,
  type SheetEditEvent,
} from './webhook-auth'
import type { WorkbookConfig } from './types'

const SECRET = 'super-secret-value'
const CONFIG: WorkbookConfig = { spreadsheetId: 'SID', sheetId: 42, headerRow: 3, templateChannelId: 'C0' }
const NOW = 1_700_000_000_000
const now = () => NOW

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ requestId: 'req-1', timestamp: NOW, spreadsheetId: 'SID', sheetId: 42, ...over })
}

describe('verifyWebhookSignature', () => {
  it('accepts a correct bare-hex or sha256=-prefixed digest, timing-safe', () => {
    const raw = body()
    const hex = createHmac('sha256', SECRET).update(raw).digest('hex')
    assert.equal(verifyWebhookSignature(SECRET, raw, hex), true)
    assert.equal(verifyWebhookSignature(SECRET, raw, `sha256=${hex}`), true)
  })
  it('rejects a wrong signature and empty inputs', () => {
    assert.equal(verifyWebhookSignature(SECRET, body(), 'sha256=deadbeef'), false)
    assert.equal(verifyWebhookSignature(SECRET, body(), ''), false)
    assert.equal(verifyWebhookSignature('', body(), sign(body())), false)
  })
})

describe('authorizeSheetEditWebhook — denial paths (uniform, fail closed)', () => {
  it('authorizes a valid, correctly-signed, in-window, matching-workbook request', () => {
    const raw = body()
    const r = authorizeSheetEditWebhook({ rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.notification.requestId, 'req-1')
      assert.equal(r.notification.spreadsheetId, 'SID')
      assert.equal(r.notification.sheetId, 42)
    }
  })

  it('denies when the secret is absent (fail closed — the Preview case)', () => {
    const raw = body()
    assert.equal(authorizeSheetEditWebhook({ rawBody: raw, signature: sign(raw), secret: undefined, config: CONFIG, now }).ok, false)
    assert.equal(authorizeSheetEditWebhook({ rawBody: raw, signature: sign(raw), secret: '', config: CONFIG, now }).ok, false)
  })

  it('denies when the workbook is not configured (fail closed)', () => {
    const raw = body()
    assert.equal(authorizeSheetEditWebhook({ rawBody: raw, signature: sign(raw), secret: SECRET, config: null, now }).ok, false)
  })

  it('denies an invalid signature', () => {
    const raw = body()
    assert.equal(authorizeSheetEditWebhook({ rawBody: raw, signature: 'sha256=bad', secret: SECRET, config: CONFIG, now }).ok, false)
    // A signature computed with the wrong secret is also rejected.
    assert.equal(authorizeSheetEditWebhook({ rawBody: raw, signature: sign(raw, 'other'), secret: SECRET, config: CONFIG, now }).ok, false)
  })

  it('denies a tampered body (signature no longer matches)', () => {
    const signed = body()
    const tampered = body({ sheetId: 99 })
    assert.equal(authorizeSheetEditWebhook({ rawBody: tampered, signature: sign(signed), secret: SECRET, config: CONFIG, now }).ok, false)
  })

  it('denies a stale OR implausibly-future timestamp', () => {
    const stale = body({ timestamp: NOW - MAX_TIMESTAMP_SKEW_MS - 1 })
    const future = body({ timestamp: NOW + MAX_TIMESTAMP_SKEW_MS + 1 })
    assert.equal(authorizeSheetEditWebhook({ rawBody: stale, signature: sign(stale), secret: SECRET, config: CONFIG, now }).ok, false)
    assert.equal(authorizeSheetEditWebhook({ rawBody: future, signature: sign(future), secret: SECRET, config: CONFIG, now }).ok, false)
  })

  it('denies malformed JSON and missing/typewrong fields', () => {
    for (const raw of ['not json', '{}', JSON.stringify({ requestId: 'x' }), JSON.stringify({ requestId: 'x', timestamp: '123', spreadsheetId: 'SID', sheetId: 42 })]) {
      assert.equal(authorizeSheetEditWebhook({ rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now }).ok, false)
    }
  })

  it('denies a request for a different spreadsheet or sheet', () => {
    const otherSheet = body({ sheetId: 7 })
    const otherBook = body({ spreadsheetId: 'OTHER' })
    assert.equal(authorizeSheetEditWebhook({ rawBody: otherSheet, signature: sign(otherSheet), secret: SECRET, config: CONFIG, now }).ok, false)
    assert.equal(authorizeSheetEditWebhook({ rawBody: otherBook, signature: sign(otherBook), secret: SECRET, config: CONFIG, now }).ok, false)
  })
})

describe('sheetEditEvent', () => {
  it('carries the named event, the requestId as the dedupe id, and minimal data', () => {
    const ev = sheetEditEvent({ requestId: 'req-9', timestamp: NOW, spreadsheetId: 'SID', sheetId: 42 })
    assert.equal(ev.name, SHEET_EDITED_EVENT)
    assert.equal(ev.id, 'req-9') // dedupe id
    assert.deepEqual(ev.data, { spreadsheet_id: 'SID', sheet_id: 42, request_id: 'req-9', ts: NOW })
  })
})

describe('handleSheetEditNotification — exactly-one-send on success, zero on denial', () => {
  function counter() {
    const sent: SheetEditEvent[] = []
    return { sent, send: async (e: SheetEditEvent) => { sent.push(e); return { ids: [e.id] } } }
  }

  it('sends exactly one event on a valid signed request', async () => {
    const raw = body()
    const c = counter()
    const out = await handleSheetEditNotification({ rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now, send: c.send })
    assert.equal(out.status, 202)
    assert.equal(out.sent, true)
    assert.equal(c.sent.length, 1)
    assert.equal(c.sent[0].name, SHEET_EDITED_EVENT)
    assert.equal(c.sent[0].id, 'req-1')
  })

  it('sends NOTHING and contacts no provider on every denial kind', async () => {
    const raw = body()
    const denials: Array<Parameters<typeof handleSheetEditNotification>[0]> = []
    const mk = (over: Partial<Parameters<typeof authorizeSheetEditWebhook>[0]>, send: (e: SheetEditEvent) => Promise<unknown>) =>
      ({ rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now, send, ...over })
    // Build each denial with its OWN counter so we can assert zero sends.
    for (const over of [
      { secret: undefined },
      { config: null },
      { signature: 'sha256=bad' },
      { rawBody: body({ timestamp: NOW - MAX_TIMESTAMP_SKEW_MS - 1 }), signature: sign(body({ timestamp: NOW - MAX_TIMESTAMP_SKEW_MS - 1 })) },
      { rawBody: 'garbage', signature: sign('garbage') },
      { rawBody: body({ spreadsheetId: 'OTHER' }), signature: sign(body({ spreadsheetId: 'OTHER' })) },
    ]) {
      const c = counter()
      const out = await handleSheetEditNotification(mk(over as any, c.send))
      assert.equal(out.status, 401, `denial should be 401 for ${JSON.stringify(Object.keys(over))}`)
      assert.equal(out.sent, false)
      assert.equal(c.sent.length, 0, 'no event sent on denial')
    }
    assert.equal(denials.length, 0)
  })

  it('repeated identical notifications each carry the SAME dedupe id (safe to replay)', async () => {
    const raw = body()
    const c = counter()
    await handleSheetEditNotification({ rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now, send: c.send })
    await handleSheetEditNotification({ rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now, send: c.send })
    assert.equal(c.sent.length, 2)
    assert.equal(c.sent[0].id, c.sent[1].id) // Inngest dedupes on this id
  })

  it('returns a retryable 500 (no send success) when the event enqueue throws', async () => {
    const raw = body()
    const out = await handleSheetEditNotification({
      rawBody: raw, signature: sign(raw), secret: SECRET, config: CONFIG, now,
      send: async () => { throw new Error('inngest down') },
    })
    assert.equal(out.status, 500)
    assert.equal(out.sent, false)
  })
})
