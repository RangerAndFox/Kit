// @ts-nocheck
/**
 * Plaud (https://plaud.ai) integration.
 *
 * Webhook verification: HMAC-SHA256 over `${timestamp}.${rawBody}`, compared
 * against the `plaud-signature` header (format: `sha256=<hex>`).
 * Spec: https://docs.plaud.ai/documentation/embedded_sdk/webhooks.md
 *
 * Transcription API fetches are stubbed and gated by PLAUD_INGEST_ENABLED.
 * When the flag is off they throw — callers must check the flag first.
 */

import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────

export interface PlaudTranscriptionCompletedEvent {
  event: 'transcription.completed'
  timestamp: string
  data: {
    transcription_id: string
    file_id: string
    language: string
    duration: number
    word_count: number
  }
}

export interface PlaudTranscriptionFailedEvent {
  event: 'transcription.failed'
  timestamp: string
  data: {
    transcription_id: string
    file_id: string
    error: string
    message: string
  }
}

export type PlaudWebhookEvent =
  | PlaudTranscriptionCompletedEvent
  | PlaudTranscriptionFailedEvent

export interface PlaudTranscript {
  text: string
  speakers: Array<{
    speaker_label: string
    text: string
    start_seconds: number
    end_seconds: number
  }>
}

export interface PlaudFile {
  name: string
  duration_seconds: number
  created_at: string
  participants?: string[]
}

// ─── Signature verification ───────────────────────────────────

/**
 * Constant-time HMAC-SHA256 verification of a Plaud webhook.
 *
 * Plaud signs `${timestamp}.${rawBody}` with the webhook secret and sends
 * the result as `sha256=<hex>` in the `plaud-signature` header.
 *
 * Returns false on any malformed input rather than throwing — callers
 * just need a boolean.
 */
export function verifyPlaudSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  if (!rawBody || !timestamp || !signature || !secret) return false
  if (!signature.startsWith('sha256=')) return false

  const provided = signature.slice('sha256='.length)
  if (!/^[0-9a-f]+$/i.test(provided)) return false

  const message = `${timestamp}.${rawBody}`
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex')

  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, 'hex'),
      Buffer.from(expected, 'hex'),
    )
  } catch {
    return false
  }
}

/**
 * Check the plaud-timestamp header is recent enough to reject capture-replays.
 * Default window is 300 seconds; override with PLAUD_TIMESTAMP_SKEW_SECONDS.
 */
export function isTimestampFresh(timestamp: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(timestamp)
  if (Number.isNaN(ts)) return false
  const skewSeconds = Number(process.env.PLAUD_TIMESTAMP_SKEW_SECONDS) || 300
  return Math.abs(nowMs - ts) <= skewSeconds * 1000
}

// ─── Transcription API (flag-gated stubs) ─────────────────────

const PLAUD_API = 'https://api.plaud.ai/v1'

function ingestEnabled(): boolean {
  return process.env.PLAUD_INGEST_ENABLED === 'true'
}

function plaudHeaders(): Record<string, string> {
  const key = process.env.PLAUD_API_KEY
  if (!key) {
    throw new Error('PLAUD_API_KEY is required when PLAUD_INGEST_ENABLED=true')
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Fetch a transcript by transcription_id. Stubbed today: throws when the
 * ingest flag is off so callers can branch cleanly.
 *
 * When the flag flips on, this calls the Plaud Transcription API.
 * Exact endpoint and response shape need to be confirmed against
 * https://docs.plaud.ai/documentation/embedded_sdk/transcription_api.md
 * once we have a working dev app.
 */
export async function fetchPlaudTranscript(
  transcriptionId: string,
): Promise<PlaudTranscript> {
  if (!ingestEnabled()) {
    throw new Error('PLAUD_INGEST_ENABLED is false — Plaud fetch path is disabled')
  }
  const res = await fetch(`${PLAUD_API}/transcriptions/${transcriptionId}`, {
    method: 'GET',
    headers: plaudHeaders(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`Plaud transcript fetch ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as PlaudTranscript
}

/**
 * Fetch file metadata (name, duration, participants if Plaud surfaces them).
 * Same flag-gating + endpoint-pending-confirmation note as fetchPlaudTranscript.
 */
export async function fetchPlaudFile(fileId: string): Promise<PlaudFile> {
  if (!ingestEnabled()) {
    throw new Error('PLAUD_INGEST_ENABLED is false — Plaud fetch path is disabled')
  }
  const res = await fetch(`${PLAUD_API}/files/${fileId}`, {
    method: 'GET',
    headers: plaudHeaders(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Plaud file fetch ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as PlaudFile
}
