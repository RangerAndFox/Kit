/** Single-attempt transport: the posting ledger, not an SDK retry loop, owns recovery. */
export async function sendCultureMessage(message: Record<string, unknown>): Promise<{ ok: true; ts: string }> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('Culture Slack connection is unavailable.')
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message), signal: AbortSignal.timeout(20000), redirect: 'error',
  })
  if (!response.ok) throw new Error('Culture Slack acknowledgement was not received.')
  const result = await response.json() as { ok?: boolean; ts?: unknown }
  if (result.ok !== true || typeof result.ts !== 'string' || !result.ts) throw new Error('Culture Slack acknowledgement was not received.')
  return { ok: true, ts: result.ts }
}
