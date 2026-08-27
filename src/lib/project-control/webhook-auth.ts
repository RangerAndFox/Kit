/**
 * Authentication for the Master Project List "Sheet edited" webhook.
 *
 * A Google Apps Script installable onEdit trigger POSTs a tiny, signed
 * notification to the production Vercel endpoint; the endpoint asks Inngest to
 * run the SAME canonical Project Control sync (never renders a canvas itself).
 *
 * This module owns ALL of the security logic so the route stays thin and the
 * denial paths are unit-tested in isolation. It is now the ONLY verified-caller
 * boundary on the Vercel surface — the Slack HTTP routes it was modelled on were
 * removed (Slack runs over Socket Mode on Railway; see `.ai/invariants.md`).
 *
 * Discipline (all fail CLOSED — a denial reveals nothing about which check
 * failed, so a probe can't distinguish "no secret" from "bad signature"):
 *   - secret absent            → deny  (Preview deployments have no secret)
 *   - malformed body / headers → deny
 *   - bad HMAC (timing-safe)   → deny
 *   - stale/again-future ts    → deny  (replay window)
 *   - wrong workbook/sheet     → deny
 * Only a fully valid, correctly-signed notification for the CONFIGURED workbook
 * is authorized, and only then is exactly one Inngest event sent.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WorkbookConfig } from './types'

/** The named Inngest event the authorized webhook emits. */
export const SHEET_EDITED_EVENT = 'project-control/sheet.edited'

/** Max clock skew (and replay window) for the signed timestamp. */
export const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000

/** The exact minimal metadata the Apps Script signs and sends. */
export interface SheetEditNotification {
  /** Unique per notification (Apps Script Utilities.getUuid()) — the dedupe id. */
  requestId: string
  /** Epoch milliseconds when the edit fired. */
  timestamp: number
  /** Must equal the configured Master Project List spreadsheet id. */
  spreadsheetId: string
  /** Must equal the configured target sheet (tab) id. */
  sheetId: number
}

export type AuthResult =
  | { ok: true; notification: SheetEditNotification }
  | { ok: false }

const DENY: AuthResult = { ok: false }

/** Constant-time HMAC-SHA256 comparison over the EXACT raw request body. */
export function verifyWebhookSignature(secret: string, rawBody: string, signature: string): boolean {
  if (!secret || !signature) return false
  // Accept a bare hex digest or a "sha256=" prefixed one (common convention).
  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function parseNotification(rawBody: string): SheetEditNotification | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const requestId = typeof p.requestId === 'string' ? p.requestId.trim() : ''
  const spreadsheetId = typeof p.spreadsheetId === 'string' ? p.spreadsheetId.trim() : ''
  const timestamp = typeof p.timestamp === 'number' ? p.timestamp : NaN
  const sheetId = typeof p.sheetId === 'number' ? p.sheetId : NaN
  if (!requestId || !spreadsheetId || !Number.isFinite(timestamp) || !Number.isFinite(sheetId)) {
    return null
  }
  return { requestId, timestamp, spreadsheetId, sheetId }
}

export interface AuthorizeArgs {
  rawBody: string
  signature: string
  /** The configured webhook secret. Absent/blank ⇒ fail closed. */
  secret: string | undefined
  /** The configured workbook. Null (e.g. Preview, unset) ⇒ fail closed. */
  config: WorkbookConfig | null
  now?: () => number
  maxSkewMs?: number
}

/**
 * Authorize a Sheet-edit notification. Order is chosen so that no observable
 * behaviour differs between failure kinds — the result is a uniform deny.
 */
export function authorizeSheetEditWebhook(args: AuthorizeArgs): AuthResult {
  const { rawBody, signature, secret, config } = args
  const now = args.now ?? Date.now
  const maxSkew = args.maxSkewMs ?? MAX_TIMESTAMP_SKEW_MS

  if (!secret || !config) return DENY // fail closed: no secret or no workbook
  if (!verifyWebhookSignature(secret, rawBody, signature)) return DENY

  const notification = parseNotification(rawBody)
  if (!notification) return DENY

  // Freshness / replay window (reject stale AND implausibly-future timestamps).
  if (Math.abs(now() - notification.timestamp) > maxSkew) return DENY

  // Exact workbook + sheet match — never act on some other spreadsheet.
  if (notification.spreadsheetId !== config.spreadsheetId) return DENY
  const allowedSheetIds = new Set([
    config.sheetId, config.linksSheetId, config.specsSheetId, config.workbackSheetId,
    config.assignmentsSheetId, config.deliverablesSheetId, config.statusLogSheetId,
  ].filter((id): id is number => id != null))
  if (!allowedSheetIds.has(notification.sheetId)) return DENY

  return { ok: true, notification }
}

/**
 * The Inngest event payload derived from an authorized notification.
 *
 * Replay dedupe is enforced at the FUNCTION level via `idempotency:
 * 'event.data.request_id'` on `projectControlSyncOnEdit` — Inngest's event-level
 * `id` does NOT deduplicate a debounced function. `data.request_id` is therefore
 * the field that actually collapses a replayed/retried notification to one run;
 * `id` is preserved as a conventional event id, not relied on for dedupe.
 */
export interface SheetEditEvent {
  name: typeof SHEET_EDITED_EVENT
  /** Conventional event id (the Apps Script requestId). Dedupe is enforced at
   *  the function level on `data.request_id`, not via this field. */
  id: string
  data: { spreadsheet_id: string; sheet_id: number; request_id: string; ts: number }
}

export function sheetEditEvent(n: SheetEditNotification): SheetEditEvent {
  return {
    name: SHEET_EDITED_EVENT,
    id: n.requestId,
    data: { spreadsheet_id: n.spreadsheetId, sheet_id: n.sheetId, request_id: n.requestId, ts: n.timestamp },
  }
}

export type HandleOutcome = { status: 200 | 202; sent: true } | { status: 401; sent: false } | { status: 500; sent: false }

/**
 * The full webhook decision: authorize, then send EXACTLY ONE Inngest event on
 * success and ZERO on any denial. `send` is injected so the route wires the real
 * `inngest.send` while tests assert send-count without touching Inngest. The
 * event is never sent before authorization succeeds (invariant: denials contact
 * no external provider).
 */
export async function handleSheetEditNotification(
  args: AuthorizeArgs & { send: (event: SheetEditEvent) => Promise<unknown> },
): Promise<HandleOutcome> {
  const auth = authorizeSheetEditWebhook(args)
  if (!auth.ok) return { status: 401, sent: false }
  try {
    await args.send(sheetEditEvent(auth.notification))
    return { status: 202, sent: true }
  } catch {
    // Authorized but the event could not be enqueued. Surface a retryable 500
    // WITHOUT leaking why; the 10-minute cron remains the recovery path.
    return { status: 500, sent: false }
  }
}
