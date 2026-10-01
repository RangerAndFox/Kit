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
 *   - bounds flat replies by the next prompt (including closed check-ins);
 *   - delegates one Slack message at a time, like the live handler; persisted
 *     reply ownership prevents reuse across days and live/recovery writers.
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

/**
 * Start strictly after the last message Kit already consumed or attempted.
 *
 * This matters after Redo: the row returns to `sent`, but `reply_ts` remains a
 * recovery cursor. Falling back to the original reminder timestamp would make
 * the poller parse the rejected hours again and resurrect the old card.
 */
export function recoveryAfterTs(row: Pick<RecoverableCheckin, 'dm_ts' | 'reply_ts'>): string {
  return row.reply_ts || (row.dm_ts as string)
}

/** Explicit replies to this reminder remain eligible after a newer prompt. */
export function messagesForRecovery(
  messages: SlackMessageLike[], row: RecoverableCheckin, nextPromptTs: string | null,
): SlackMessageLike[] {
  return messages.filter(message => {
    if (Number(message.ts) <= Number(recoveryAfterTs(row))) return false
    if (message.thread_ts && message.thread_ts !== message.ts) return message.thread_ts === row.dm_ts
    return !nextPromptTs || Number(message.ts) < Number(nextPromptTs)
  })
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
      // Start after the last message already consumed on every status. A redo
      // returns the row to `sent`, but must not make the rejected reply visible
      // to this recovery poll again.
      const afterTs = recoveryAfterTs(row)
      // Open-only scans cannot see that a later check-in has already logged.
      // Query ALL states so yesterday cannot ingest today's completed reply.
      const { data: next, error: nextError } = await sb.from('daily_hours_checkins')
        .select('dm_ts').eq('staff_id', row.staff_id).eq('dm_channel_id', channel)
        .gt('dm_ts', rootTs).order('dm_ts', { ascending: true }).limit(1)
      if (nextError) throw new Error(`load next check-in prompt: ${nextError.message}`)
      const nextPromptTs = next?.[0]?.dm_ts || null
      const history: any = nextPromptTs && Number(afterTs) >= Number(nextPromptTs)
        ? { messages: [] }
        : await app.client.conversations.history({
        channel,
        oldest: afterTs,
        ...(nextPromptTs ? { latest: nextPromptTs } : {}),
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
      return messagesForRecovery([...byTs.values()], row, nextPromptTs)
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
        expectedCheckinId: row.id,
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
      // Do not combine independently delivered messages under only the first
      // message's ownership key. Match live handling: one event, one claim.
      const burst = extractReplyBurst(messages, row.slack_user_id, { burstGapMinutes: 0 })
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
