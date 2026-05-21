// @ts-nocheck
/**
 * Plaud webhook receiver.
 *
 * Plaud sends `transcription.completed` and `transcription.failed` events.
 * Spec: docs/superpowers/specs/2026-05-21-plaud-migration-design.md
 *
 * This route does only signature verification, replay protection, and
 * Inngest dispatch. All real work happens inside the Inngest functions
 * defined in src/lib/inngest/plaud.ts so we can return 200 inside Plaud's
 * 10-second webhook timeout.
 */

import type { NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { verifyPlaudSignature, isTimestampFresh } from '@/lib/integrations/plaud'

export async function POST(request: NextRequest) {
  const secret = process.env.PLAUD_WEBHOOK_SECRET
  if (!secret) {
    console.error('[plaud-webhook] PLAUD_WEBHOOK_SECRET is not set')
    return Response.json({ error: 'webhook not configured' }, { status: 500 })
  }

  // Raw body needed for HMAC. Do not JSON.parse before verifying.
  const rawBody = await request.text()
  const signature = request.headers.get('plaud-signature') || ''
  const timestamp = request.headers.get('plaud-timestamp') || ''

  if (!verifyPlaudSignature(rawBody, timestamp, signature, secret)) {
    console.warn('[plaud-webhook] bad signature')
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  if (!isTimestampFresh(timestamp)) {
    console.warn(`[plaud-webhook] stale timestamp ${timestamp}`)
    return Response.json({ error: 'stale timestamp' }, { status: 401 })
  }

  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch (err) {
    console.warn('[plaud-webhook] malformed JSON', err)
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  const eventName = body?.event
  const data = body?.data

  if (!eventName || !data) {
    return Response.json({ error: 'missing event or data' }, { status: 400 })
  }

  // Dispatch to Inngest. Unknown events log + 200 (forward compatibility).
  switch (eventName) {
    case 'transcription.completed':
      await inngest.send({
        name: 'plaud/transcription.ready',
        data,
      })
      break
    case 'transcription.failed':
      await inngest.send({
        name: 'plaud/transcription.failed',
        data,
      })
      break
    default:
      console.log(`[plaud-webhook] unknown event '${eventName}' — acknowledged but not dispatched`)
  }

  return Response.json({ received: true }, { status: 200 })
}
