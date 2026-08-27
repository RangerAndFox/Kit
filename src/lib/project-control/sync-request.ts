import { createHmac, randomUUID } from 'node:crypto'
import type { WorkbookConfig } from './types'

/**
 * Ask the canonical Vercel/Inngest sync to refresh after a Sheets API write.
 * Google installable edit triggers only fire for human edits, so Railway calls
 * the same authenticated endpoint explicitly. Failure is non-fatal because the
 * ten-minute cron remains the durable convergence path.
 */
export async function requestProjectControlSync(
  config: WorkbookConfig,
  sheetId: number,
  env: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch,
): Promise<boolean> {
  const url = env.PROJECT_CONTROL_WEBHOOK_URL?.trim()
  const secret = env.PROJECT_CONTROL_WEBHOOK_SECRET?.trim()
  if (!url || !secret) return false

  const body = JSON.stringify({
    requestId: randomUUID(),
    timestamp: Date.now(),
    spreadsheetId: config.spreadsheetId,
    sheetId,
  })
  const signature = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
  try {
    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kit-signature': signature },
      body,
      signal: AbortSignal.timeout(8_000),
    })
    return response.ok
  } catch {
    return false
  }
}
