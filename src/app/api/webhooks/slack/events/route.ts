// @ts-nocheck
import { NextResponse, after } from 'next/server'
import { verifySlackSignature } from '@/lib/slack/verify'
import { slackAuthDenied } from '@/lib/slack/deny'
import { routeWebhook } from '@/lib/managed-agents/webhook-router'
import { createAdminClient } from '@/lib/supabase/admin'
import { messageHasFrameIoLink, handleFrameIoLink } from '@/lib/frameio/slack-handler'
import { isTimeEntryMessage, handleTimeEntry } from '@/lib/harvest/slack-handler'

export const maxDuration = 60

const ROUTE = '/api/webhooks/slack/events'

/**
 * Slack Events API webhook.
 *
 * Handles:
 *  - url_verification challenge (one-time, when setting up the Request URL)
 *  - app_mention (when a user @mentions Kit)
 *  - message.im (DMs to Kit)
 *  - message.channels (optional — messages in channels Kit is in)
 *
 * Verifies the Slack signing secret on every request per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function POST(request: Request) {
  try {
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

    // Parsed only after the request is proven to come from Slack. The
    // url_verification challenge is itself signed, so it needs no exemption.
    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // 1) URL verification challenge (respond immediately with the challenge token)
    if (payload.type === 'url_verification') {
      return NextResponse.json({ challenge: payload.challenge })
    }

    // 2) Event callbacks — app_mention, message.im, message.channels
    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event

      // Ignore bot messages to prevent feedback loops
      if (event.bot_id || event.subtype === 'bot_message') {
        return NextResponse.json({ ok: true, ignored: 'bot_message' })
      }

      // Only respond to relevant event types
      const relevantTypes = ['app_mention', 'message']
      if (!relevantTypes.includes(event.type)) {
        return NextResponse.json({ ok: true, ignored: event.type })
      }

      // Look up the Slack team_id → workspace mapping
      const teamId = payload.team_id as string
      const workspaceId = await resolveWorkspaceId(teamId)

      // Fire-and-forget dispatch (Slack expects a response within 3s).
      // After the agent produces a response, we post it back to Slack
      // using chat.postMessage with the bot token.
      const channelId = event.channel
      const threadTs = event.thread_ts || event.ts

      // Run the agent dispatch AFTER the response is returned to Slack.
      // Vercel's `after()` keeps the serverless function alive for background work.
      after(async () => {
        try {
          // ── Frame.io link detection ──────────────────────────
          // If the message contains a Frame.io review/player link,
          // extract review notes into an xlsx and upload to the thread.
          const messageText = event.text || ''
          console.log('[Slack] Event received:', { type: event.type, text: messageText?.slice(0, 200), channel: channelId })
          if (messageHasFrameIoLink(messageText)) {
            console.log('[Slack] Frame.io link detected, starting extraction...')
            await handleFrameIoLink({
              text: messageText,
              channelId,
              threadTs,
              messageTs: event.ts,
              userId: event.user,
              workspaceId,
            })
            return // handled — skip agent dispatch for this message
          }

          // ── Harvest time entry detection ────────────────────
          // If the message looks like a casual time log, parse it
          // and route to the Harvest handler.
          if (isTimeEntryMessage(messageText)) {
            console.log('[Slack] Time entry detected, routing to Harvest handler...')
            await handleTimeEntry({
              text: messageText,
              channelId,
              threadTs,
              messageTs: event.ts,
              userId: event.user,
              workspaceId,
            })
            return // handled — skip agent dispatch
          }

          const result = await routeWebhook('slack_message', {
            workspaceId,
            source: `slack:${event.type}`,
            payload: {
              team_id: teamId,
              channel_id: channelId,
              channel_name: event.channel_name || '',
              user_id: event.user,
              user_name: event.user_name || '',
              text: event.text || '',
              ts: event.ts,
              thread_ts: event.thread_ts,
              event_type: event.type,
            },
          })

          const responseText = extractAgentText(result.events)
          if (responseText && channelId) {
            await postSlackMessage(channelId, responseText)
          } else {
            console.warn('[Slack] No response text to post', {
              sessionId: result.sessionId,
              eventCount: result.events?.length || 0,
            })
          }
        } catch (err) {
          console.error('[Slack] Dispatch failed:', err)
          if (channelId) {
            await postSlackMessage(
              channelId,
              `I hit an error processing that: ${err?.message || 'unknown'}`,
              threadTs
            )
          }
        }
      })

      return NextResponse.json({ ok: true })
    }

    // Unknown payload type
    return NextResponse.json({ ok: true, ignored: payload.type })
  } catch (error) {
    console.error('[Slack Events] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Extract the text content of the agent's response from the event stream.
 * Tries several common event shapes since the Managed Agents API is still in beta.
 */
function extractAgentText(events: any[] | undefined): string {
  if (!events || events.length === 0) return ''

  const parts: string[] = []

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue

    const type = String(evt.type || '')

    // Skip events that are from the user (we sent these)
    if (type.startsWith('user.')) continue

    // Skip tool-related events — we want final text, not tool I/O
    if (
      type.startsWith('tool_') ||
      type.includes('tool_use') ||
      type.includes('tool_result') ||
      type.includes('tool.')
    ) continue

    // Only collect text from agent/assistant/message events
    const isAgentEvent =
      type.startsWith('agent.') ||
      type.startsWith('assistant.') ||
      type === 'message' ||
      type === 'message.completed' ||
      type === 'agent_message'

    if (!isAgentEvent) continue

    // Shape A: content array with text blocks
    if (Array.isArray(evt.content)) {
      for (const block of evt.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
    }

    // Shape B: direct text field
    if (typeof evt.text === 'string') {
      parts.push(evt.text)
    }

    // Shape C: message.text
    if (evt.message?.text && typeof evt.message.text === 'string') {
      parts.push(evt.message.text)
    }
  }

  return parts.join('').trim()
}

/**
 * Post a message to Slack via chat.postMessage.
 */
async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.error('[Slack] SLACK_BOT_TOKEN not set, cannot post')
    return
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(
        threadTs
          ? { channel, text, thread_ts: threadTs }
          : { channel, text }
      ),
    })

    const data = await res.json()
    if (!data.ok) {
      console.error('[Slack] chat.postMessage failed:', data.error, data)
    }
  } catch (err) {
    console.error('[Slack] Post failed:', err)
  }
}

/**
 * Resolve a Slack team_id to a Kit workspace_id.
 * Falls back to the first workspace if no mapping exists (single-tenant dev setup).
 */
async function resolveWorkspaceId(teamId: string): Promise<string> {
  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('workspaces' as any)
      .select('id, slack_team_id')
      .eq('slack_team_id', teamId)
      .limit(1)
      .single()

    if (data?.id) return data.id as string

    // Fallback: return first workspace
    const { data: first } = await supabase
      .from('workspaces' as any)
      .select('id')
      .limit(1)
      .single()

    return (first?.id as string) || ''
  } catch {
    return ''
  }
}
