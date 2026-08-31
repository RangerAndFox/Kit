/**
 * Post a message to Slack as Kit's bot (chat.postMessage). A `channel` of a
 * user id (U…) opens/uses that person's DM, so this doubles as "DM a user".
 *
 * Fire-and-forget and defensive: no token, no channel, or a Slack/network
 * error must never throw into a cron step. Mirrors the watchdog's posting
 * contract so both health paths speak to Slack the same way.
 */
export async function postSlackAsKit(channel: string, text: string): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel) return false
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text, mrkdwn: true, unfurl_links: false }),
      signal: AbortSignal.timeout(8_000),
    })
    const body = await res.json().catch(() => null)
    return !!body?.ok
  } catch {
    return false
  }
}
