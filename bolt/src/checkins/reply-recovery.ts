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
import { handleCheckinReply } from './reply'

export interface RecoverableCheckin {
  id: string
  staff_id: string
  slack_user_id: string
  check_in_date: string
  status: string
  dm_channel_id: string | null
  dm_ts: string | null
  candidate_projects: any
}

export interface ReplyRecoveryDeps {
  loadOpen(): Promise<RecoverableCheckin[]>
  readMessages(row: RecoverableCheckin): Promise<SlackMessageLike[]>
  handle(row: RecoverableCheckin, replyText: string, replyTs: string): Promise<boolean>
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
          'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, candidate_projects',
        )
        .gte('check_in_date', checkinDateMinusDays(2))
        .in('status', ['sent', 'nudged'])
        .not('dm_channel_id', 'is', null)
        .not('dm_ts', 'is', null)
        .order('created_at', { ascending: false })
      if (error) throw new Error(`load open check-ins: ${error.message}`)
      return (data || []) as RecoverableCheckin[]
    },

    async readMessages(row) {
      const channel = row.dm_channel_id as string
      const rootTs = row.dm_ts as string
      const history: any = await app.client.conversations.history({
        channel,
        oldest: rootTs,
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
        if (message?.ts && Number(message.ts) > Number(rootTs)) byTs.set(message.ts, message)
      }
      return [...byTs.values()]
    },

    handle(row, replyText, replyTs) {
      return handleCheckinReply({ app, open: row as any, replyText, replyTs })
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
      if (!burst || !looksLikeRecoverableCheckinReply(burst.text)) {
        tally.ignored++
        continue
      }
      const handled = await deps.handle(row, burst.text, burst.ts)
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
