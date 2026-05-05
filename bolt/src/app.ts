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
import { registerMessageHandlers, handleConversationalMessage } from './handlers/messages'
import { registerCommandHandlers } from './handlers/commands'
import { registerInteractionHandlers } from './handlers/interactions'

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
  userMessage: async ({ message, client }) => {
    const m = message as any
    if (m.bot_id || m.subtype) return

    await handleConversationalMessage({
      app,
      channelId: m.channel,
      userId: m.user,
      teamId: m.team || '',
      messageText: (m.text || '').trim(),
      messageTs: m.ts,
      threadTs: m.thread_ts || m.ts,
      isDirectMention: false,
    })
  },
})

app.assistant(assistant)

// ─── Register Handlers ─────────────────────────────────────

registerMessageHandlers(app)
registerCommandHandlers(app)
registerInteractionHandlers(app)

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

// Heartbeat so we can see how long we live and whether anything happens before SIGTERM
setInterval(() => {
  console.log(`[Bolt] heartbeat — uptime ${Math.floor(process.uptime())}s, mem ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`)
}, 5000)

// ─── Health Server ─────────────────────────────────────────
// Railway expects a service to bind to $PORT — without it, the platform
// kills the container after ~7s thinking it's broken. Bolt's Socket Mode
// is outbound-only, so we run a tiny HTTP server alongside that responds
// 200 to anything. It's purely a Railway lifecycle formality.

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Kit OK')
  })
  .listen(PORT, () => {
    console.log(`   Health server: listening on :${PORT}`)
  })

// ─── Start ─────────────────────────────────────────────────

;(async () => {
  await app.start()
  console.log('⚡ Kit is online (Socket Mode)')
  console.log(`   Bot token: ...${process.env.SLACK_BOT_TOKEN?.slice(-6)}`)
  console.log(`   App token: ...${process.env.SLACK_APP_TOKEN?.slice(-6)}`)
  console.log(`   Anthropic key: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'}`)
})()
