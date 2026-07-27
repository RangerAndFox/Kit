/**
 * Master Project List "Sheet edited" webhook (Vercel-owned, Production-only).
 *
 * A Google Apps Script installable onEdit trigger POSTs a tiny HMAC-signed
 * notification here. On successful authentication this endpoint emits exactly
 * ONE `project-control/sheet.edited` Inngest event, which runs the SAME
 * canonical `runProjectControlSync` core as the 10-minute cron. This route
 * NEVER renders a canvas or calls Slack directly.
 *
 * All security logic lives in the provider-owned helper
 * (`@/lib/project-control/webhook-auth`); the route only wires the real
 * `inngest.send`. Denials are a uniform 401 (no detail on which check failed);
 * an absent secret (e.g. any Preview deployment) fails closed → 401, so Preview
 * has no path to a production effect.
 */

import type { NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { workbookConfigFromEnv } from '@/lib/project-control/types'
import { handleSheetEditNotification, type SheetEditEvent } from '@/lib/project-control/webhook-auth'

// Tiny, fast route: authenticate + enqueue one event. The heavy sync runs in the
// Inngest function, not here.
export const maxDuration = 10

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text()
  const signature =
    request.headers.get('x-kit-signature') || request.headers.get('x-signature') || ''

  const outcome = await handleSheetEditNotification({
    rawBody,
    signature,
    secret: process.env.PROJECT_CONTROL_WEBHOOK_SECRET,
    config: workbookConfigFromEnv(),
    // The event `id` is the notification's requestId ⇒ Inngest dedupes replays.
    send: (event: SheetEditEvent) => inngest.send({ name: event.name, id: event.id, data: event.data }),
  })

  if (outcome.status === 401) {
    // Uniform unauthorized — reveals nothing about secret vs signature vs workbook.
    return Response.json({ ok: false }, { status: 401 })
  }
  if (outcome.status === 500) {
    return Response.json({ ok: false }, { status: 500 })
  }
  return Response.json({ ok: true }, { status: 202 })
}
