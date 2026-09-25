export interface SlackResponse {
  ok?: boolean; ts?: string; error?: string; user_id?: string
  messages?: Array<{ ts?: string; user?: string; metadata?: { event_type?: string; event_payload?: { delivery_key?: string } } }>
  response_metadata?: { next_cursor?: string }
}

/** Transport only; callers own authorization, retry policy and durable state. */
export async function slackCall(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('Slack token is not configured')
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  })
  // A 5xx, malformed response or timeout is an UNKNOWN post outcome.
  if (response.status >= 500) throw new Error('Slack response unavailable')
  const result = await response.json() as SlackResponse
  if (typeof result.ok !== 'boolean') throw new Error('Slack response invalid')
  return result
}
