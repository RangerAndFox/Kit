import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Verifies a Slack request signature per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  if (!timestamp || !signature) return false

  // Absolute ±300s window. A one-sided check (only "too old") accepts a
  // materially future-dated timestamp, so a captured body could be replayed
  // indefinitely by re-signing it with a future ts. Reject both directions.
  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false

  const sigBase = `v0:${timestamp}:${body}`
  const hmac = createHmac('sha256', secret)
  hmac.update(sigBase)
  const computed = `v0=${hmac.digest('hex')}`

  try {
    const a = Buffer.from(computed)
    const b = Buffer.from(signature)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
