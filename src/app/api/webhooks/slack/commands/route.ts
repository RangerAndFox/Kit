// @ts-nocheck
import { verifySlackSignature } from '@/lib/slack/verify'
import { slackAuthDenied } from '@/lib/slack/deny'
import { buildNewProjectModal } from '@/lib/provisioner/modal'

const ROUTE = '/api/webhooks/slack/commands'

export const maxDuration = 10

/**
 * POST /api/webhooks/slack/commands
 *
 * Receives Slack slash commands (application/x-www-form-urlencoded).
 * Routes /kit subcommands. Currently supports: newproject.
 */
export async function POST(request: Request) {
  const rawBody = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp') || ''
  const signature = request.headers.get('x-slack-signature') || ''

  // Authorization runs before any semantic parsing or side effect. An absent or
  // empty signing secret DENIES — missing configuration must never grant access.
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret || signingSecret.trim() === '') {
    return slackAuthDenied({ route: ROUTE, reason: 'signing_secret_missing', request })
  }
  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    return slackAuthDenied({ route: ROUTE, reason: 'invalid_signature', request })
  }

  const params = new URLSearchParams(rawBody)
  const text = (params.get('text') || '').trim()
  const triggerId = params.get('trigger_id') || ''
  const channelId = params.get('channel_id') || ''
  const subcommand = text.split(/\s+/)[0]?.toLowerCase() || 'help'

  if (subcommand === 'newproject') {
    // Open the intake modal using trigger_id (must happen within 3s)
    const modal = buildNewProjectModal(channelId)

    const res = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ trigger_id: triggerId, view: modal }),
    })

    const data = await res.json()
    if (!data.ok) {
      console.error('[Commands] views.open failed:', data.error)
      return new Response(
        JSON.stringify({ response_type: 'ephemeral', text: `Failed to open form: ${data.error}` }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Return empty 200 — Slack is happy, modal is open
    return new Response('', { status: 200 })
  }

  // Unknown subcommand
  return new Response(
    JSON.stringify({
      response_type: 'ephemeral',
      text: `Unknown command. Try \`/kit newproject\` or \`/kit help\``,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
