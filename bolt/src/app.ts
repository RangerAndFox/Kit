// @ts-nocheck
/**
 * Kit Bolt App
 *
 * Persistent Slack bot using Socket Mode — no webhooks, no cold starts,
 * no 60-second timeout. Runs 24/7 on Railway.
 */

import 'dotenv/config'
import http from 'node:http'
import { App, Assistant, LogLevel } from '@slack/bolt'
import {
  registerMessageHandlers,
  handleConversationalMessage,
  handleStoryboardFileDropFromAssistant,
  isStoryboardScriptFile,
  isStoryboardTrigger,
  handleStoryboardKeywordFromAssistant,
  isNewProjectTrigger,
  handleNewProjectKeywordFromAssistant,
} from './handlers/messages'
import { registerCommandHandlers } from './handlers/commands'
import { registerInteractionHandlers } from './handlers/interactions'
import { registerBrainApprovalHandlers } from './brain/approvals'
import {
  verifyDropboxSignature,
  processDropboxNotification,
} from './watchers/dropbox'
import cron from 'node-cron'
import { sendAllDailyCheckins, nudgePendingCheckins } from './checkins/daily-hours'
import { dispatchAllPendingApprovals } from './brain/approvals'

// ─── Boot ──────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG, // verbose: log every event received over Socket Mode
})

// ─── Register Assistant ────────────────────────────────────
// "Agents & AI Apps" is enabled in the Slack workspace, so DMs to Kit
// arrive via the Assistant flow rather than plain message events. We
// route those through the same orchestrator as regular messages.

const assistant = new Assistant({
  threadStarted: async ({ event, say }) => {
    // Optional: post a brief greeting when a user opens an Assistant thread.
    // Keep it short so we don't double-greet on the first user message.
    try {
      await say({ text: 'Hey! What can I help with?' })
    } catch {
      /* non-fatal */
    }
  },
  userMessage: async ({ message }) => {
    const m = message as any
    if (m.bot_id) return

    // ── Storyboard file drop in an Assistant thread ────────
    if (
      m.subtype === 'file_share' &&
      Array.isArray(m.files) &&
      m.files.length > 0
    ) {
      const scriptFile = m.files.find(isStoryboardScriptFile)
      if (scriptFile) {
        await handleStoryboardFileDropFromAssistant(app, {
          file: scriptFile,
          channelId: m.channel,
          userId: m.user,
          assistantThreadTs: m.thread_ts,
        })
        return
      }
    }

    if (m.subtype) return

    // ── Storyboard keyword shortcut in an Assistant thread ─
    if (isStoryboardTrigger((m.text || '').trim())) {
      await handleStoryboardKeywordFromAssistant(app, {
        channelId: m.channel,
        userId: m.user,
        assistantThreadTs: m.thread_ts,
      })
      return
    }

    // ── New-project keyword shortcut in an Assistant thread ─
    if (isNewProjectTrigger((m.text || '').trim())) {
      await handleNewProjectKeywordFromAssistant(app, {
        channelId: m.channel,
        assistantThreadTs: m.thread_ts,
      })
      return
    }

    // The Assistant userMessage callback always fires inside an
    // Assistant thread, so we always have a thread_ts to reply into.
    await handleConversationalMessage({
      app,
      channelId: m.channel,
      userId: m.user,
      teamId: m.team || '',
      messageText: (m.text || '').trim(),
      messageTs: m.ts,
      threadTs: m.thread_ts || m.ts,
      isDirectMention: false,
      channelType: m.channel_type,
      assistantThreadTs: m.thread_ts,
    })
  },
})

app.assistant(assistant)

// ─── Register Handlers ─────────────────────────────────────

registerMessageHandlers(app)
registerCommandHandlers(app)
registerInteractionHandlers(app)
registerBrainApprovalHandlers(app)

// ─── Resilience + Diagnostics ──────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[Bolt] Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[Bolt] Uncaught exception:', err)
})

// Log who's killing us and when
process.on('SIGTERM', () => {
  console.log(`[Bolt] received SIGTERM at uptime ${Math.floor(process.uptime())}s — exiting`)
  process.exit(0)
})
process.on('SIGINT', () => {
  console.log(`[Bolt] received SIGINT at uptime ${Math.floor(process.uptime())}s — exiting`)
  process.exit(0)
})

// ─── HTTP Server: Health + Dropbox Webhook ─────────────────
// Railway needs us bound to $PORT. The same server hosts:
//   • Any path / method → 200 OK (Railway health pings)
//   • GET  /webhooks/dropbox?challenge=... → echo challenge (one-time verify)
//   • POST /webhooks/dropbox → HMAC-verify and trigger cursor processing
// The webhook handler responds 200 within milliseconds; the cursor pull
// + uploads run after the response has been sent.

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001

http
  .createServer((req, res) => {
    const url = req.url || '/'

    // Dropbox verification — echo the challenge back as text/plain.
    if (req.method === 'GET' && url.startsWith('/webhooks/dropbox')) {
      const challenge = new URL(url, 'http://localhost').searchParams.get('challenge') || ''
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(challenge)
      return
    }

    // Dropbox notification — HMAC-verify, ACK fast, process async.
    if (req.method === 'POST' && url.startsWith('/webhooks/dropbox')) {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.from(c)))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const sig = (req.headers['x-dropbox-signature'] as string) || ''

        if (!verifyDropboxSignature(raw, sig)) {
          console.warn('[Dropbox webhook] signature mismatch — rejecting')
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('invalid signature')
          return
        }

        // ACK immediately so Dropbox doesn't retry.
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')

        // Fire-and-forget the actual delta pull.
        processDropboxNotification(app).catch((err) => {
          console.error('[Dropbox webhook] processing failed:', err)
        })
      })
      return
    }

    // Fallback: Railway health pings + anything else.
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Kit OK')
  })
  .listen(PORT, () => {
    console.log(`   Health + webhook server: listening on :${PORT}`)
  })

// ─── Cron: daily hours check-in ────────────────────────────
// 5pm local — send the prompt; 10pm — single nudge if no reply.
// Timezone is configurable; Ranger & Fox defaults to America/Los_Angeles.
// Set CHECKIN_TIMEZONE to override.

const CHECKIN_TZ = process.env.CHECKIN_TIMEZONE || 'America/Los_Angeles'

cron.schedule(
  '0 17 * * 1-5',
  () => {
    sendAllDailyCheckins(app).catch((err) =>
      console.error('[cron] daily-checkins fire failed:', err),
    )
  },
  { timezone: CHECKIN_TZ },
)

cron.schedule(
  '0 22 * * 1-5',
  () => {
    nudgePendingCheckins(app).catch((err) =>
      console.error('[cron] nudge fire failed:', err),
    )
  },
  { timezone: CHECKIN_TZ },
)

// ─── Cron: brain scavenger DM dispatch ─────────────────────
// The Inngest cron (brainScavengerScan) populates the pending queue
// daily at 7am UTC. This cron runs a few minutes later (in the box's
// local time) to DM each affected brain's channel creator with the
// approve/reject buttons. Gated on KIT_BRAIN_SCAVENGER_ENABLED so
// it stays off until the operator activates the scavenger.

cron.schedule(
  '15 7 * * *',
  () => {
    if (process.env.KIT_BRAIN_SCAVENGER_ENABLED !== 'true') return
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) return
    dispatchAllPendingApprovals({ app, workspaceId })
      .then((res) => console.log('[cron] brain-scavenger-dispatch:', res))
      .catch((err) => console.error('[cron] brain-scavenger-dispatch failed:', err))
  },
  { timezone: 'UTC' },
)

// ─── Start ─────────────────────────────────────────────────

;(async () => {
  await app.start()
  console.log('⚡ Kit is online (Socket Mode)')
  console.log(`   Bot token: ...${process.env.SLACK_BOT_TOKEN?.slice(-6)}`)
  console.log(`   App token: ...${process.env.SLACK_APP_TOKEN?.slice(-6)}`)
  console.log(`   Anthropic key: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'}`)
  console.log(`   Cron timezone: ${CHECKIN_TZ}`)
})()
