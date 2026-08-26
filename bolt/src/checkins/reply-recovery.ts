// @ts-nocheck
/**
 * Recover hours replies that Slack did not deliver as Socket Mode events.
 *
 * Scheduled reminders live in each staff member's private one-person Kit
 * channel. Slack can retain a perfectly valid user reply in channel history
 * without delivering `message.groups` to the running app (for example when
 * the app's event subscription lags the deployed handler). The normal event
 * path remains primary; this bounded poll is a durable safety net.
 *
 * Safety:
 *   - scans only recent, open scheduled check-ins;
 *   - considers only the expected Slack user after the reminder timestamp;
 *   - requires explicit hours/skip intent before invoking the parser;
 *   - delegates to handleCheckinReply, whose database compare-and-set means a
 *     live event and this recovery pass cannot process the same reply twice.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { looksLikeHoursIntent } from './adhoc'
import { checkinDateMinusDays } from './date'
import { extractReplyBurst, type SlackMessageLike } from './recovery'
import { handleCheckinReply, handleParsedCheckinText, parseConfirmDecision } from './reply'

export interface RecoverableCheckin {
  id: string
  staff_id: string
  slack_user_id: string
  check_in_date: string
  status: string
  dm_channel_id: string | null
  dm_ts: string | null
  reply_ts?: string | null
  candidate_projects: any
}

export interface ReplyRecoveryDeps {
  loadOpen(): Promise<RecoverableCheckin[]>
  readMessages(row: RecoverableCheckin): Promise<SlackMessageLike[]>
  handle(row: RecoverableCheckin, replyText: string, replyTs: string): Promise<boolean>
  handleParsed(row: RecoverableCheckin, replyText: string): Promise<boolean>
}

export interface ReplyRecoveryTally {
  scanned: number
  recovered: number
  ignored: number
  failed: number
}

const SKIP_RE = /^(?:skip|off|no work|didn't work|pto)[.\s!]*$/i

/** Keep the recovery poll narrower than the live message handler. */
export function looksLikeRecoverableCheckinReply(text: string): boolean {
  const trimmed = (text || '').trim()
  return !!trimmed && (looksLikeHoursIntent(trimmed) || SKIP_RE.test(trimmed))
}

export function makeReplyRecoveryDeps(app: App): ReplyRecoveryDeps {
  const sb = createAdminClient()
  return {
    async loadOpen() {
      const { data, error } = await sb
        .from('daily_hours_checkins')
        .select(
          'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, reply_ts, candidate_projects',
        )
        .gte('check_in_date', checkinDateMinusDays(2))
        .in('status', ['sent', 'nudged', 'parsed'])
        .not('dm_channel_id', 'is', null)
        .not('dm_ts', 'is', null)
        .order('created_at', { ascending: false })
      if (error) throw new Error(`load open check-ins: ${error.message}`)
      // Partial retries retain the original work date, so they may sit outside
      // the ordinary two-day recovery scan while remaining safely actionable.
      const { data: retries, error: retryError } = await sb
        .from('daily_hours_checkins')
        .select(
          'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, reply_ts, candidate_projects',
        )
        .gte('check_in_date', checkinDateMinusDays(14))
        .eq('origin', 'partial-retry')
        .in('status', ['sent', 'nudged', 'parsed'])
        .not('dm_channel_id', 'is', null)
        .not('dm_ts', 'is', null)
      if (retryError) throw new Error(`load partial retry check-ins: ${retryError.message}`)
      const byId = new Map<string, RecoverableCheckin>()
      for (const row of [...(data || []), ...(retries || [])]) byId.set(row.id, row as RecoverableCheckin)
      return [...byId.values()]
    },

    async readMessages(row) {
      const channel = row.dm_channel_id as string
      const rootTs = row.dm_ts as string
      // A parsed row has already consumed the original hours reply. Start
      // strictly after it so recovery sees only a later yes/redo decision.
      const afterTs = row.status === 'parsed' && row.reply_ts ? row.reply_ts : rootTs
      const history: any = await app.client.conversations.history({
        channel,
        oldest: afterTs,
        inclusive: true,
        limit: 100,
      })

      // A person can answer either in the channel or in the reminder's thread.
      // Thread history is best-effort: some Slack installations permit channel
      // history but not replies for a bot token. Channel recovery must continue.
      let threadMessages: any[] = []
      try {
        const thread: any = await app.client.conversations.replies({
          channel,
          ts: rootTs,
          oldest: rootTs,
          inclusive: true,
          limit: 100,
        })
        threadMessages = thread.messages || []
      } catch {
        /* channel history is sufficient for top-level replies */
      }

      const byTs = new Map<string, SlackMessageLike>()
      for (const message of [...(history.messages || []), ...threadMessages]) {
        if (message?.ts && Number(message.ts) > Number(afterTs)) byTs.set(message.ts, message)
      }
      return [...byTs.values()]
    },

    handle(row, replyText, replyTs) {
      return handleCheckinReply({ app, open: row as any, replyText, replyTs })
    },

    handleParsed(row, replyText) {
      return handleParsedCheckinText({
        app,
        slackUserId: row.slack_user_id,
        replyText,
        responseChannelId: row.dm_channel_id || undefined,
      })
    },
  }
}

export async function recoverMissedCheckinReplies(
  app: App,
  injected?: ReplyRecoveryDeps,
): Promise<ReplyRecoveryTally> {
  const deps = injected || makeReplyRecoveryDeps(app)
  const rows = await deps.loadOpen()
  const tally: ReplyRecoveryTally = { scanned: rows.length, recovered: 0, ignored: 0, failed: 0 }

  for (const row of rows) {
    try {
      if (!row.dm_channel_id || !row.dm_ts) {
        tally.ignored++
        continue
      }
      const messages = await deps.readMessages(row)
      const burst = extractReplyBurst(messages, row.slack_user_id)
      const eligible = row.status === 'parsed'
        ? !!burst && !!parseConfirmDecision(burst.text)
        : !!burst && looksLikeRecoverableCheckinReply(burst.text)
      if (!burst || !eligible) {
        tally.ignored++
        continue
      }
      const handled = row.status === 'parsed'
        ? await deps.handleParsed(row, burst.text)
        : await deps.handle(row, burst.text, burst.ts)
      if (handled) tally.recovered++
      else tally.ignored++
    } catch (err: any) {
      tally.failed++
      console.warn(
        `[checkin-recovery] ${row.slack_user_id} failed: ${err?.message || String(err)}`,
      )
    }
  }

  if (tally.recovered || tally.failed) {
    console.log(
      `[checkin-recovery] done — scanned=${tally.scanned} recovered=${tally.recovered} ` +
        `ignored=${tally.ignored} failed=${tally.failed}`,
    )
  }
  return tally
}
