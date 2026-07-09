// @ts-nocheck
/**
 * Brain Scavenger — DM-based approval flow.
 *
 * The scavenger queues candidates as pending brain_scavenger_candidates
 * rows. This module:
 *   1. Resolves the channel creator for each affected brain.
 *   2. DMs them a Block Kit message: one row per candidate with
 *      "Approve" / "Reject" buttons.
 *   3. On button click, applies an `add` patch to the brain (with the
 *      candidate's source_ref as provenance) or marks rejected.
 *   4. After approval, posts an in-channel notice + refreshes the
 *      canvas so the team sees the new context immediately.
 *
 * This is the one path that ALWAYS asks for human approval, regardless
 * of the brain's autonomy setting (KIT-BRAIN-SPEC.md §3.3, §4).
 */

import type { App } from '@slack/bolt'
import {
  getPendingForBrain,
  getCandidate,
  claimCandidate,
  releaseCandidate,
  markCandidatesDmSent,
  type PendingCandidateRow,
} from '../../../src/lib/brain/scavenger'
import { applyPatches, getBrainById, setCanvasHandle } from '../../../src/lib/brain/store'
import { createOrUpdateBrainCanvas } from '../../../src/lib/brain/canvas'

const ACTION_APPROVE = 'brain_scavenger_approve'
const ACTION_REJECT = 'brain_scavenger_reject'

// ─── Channel-creator resolution ────────────────────────────────────────────

export async function resolveChannelCreator(app: App, channelId: string): Promise<string | null> {
  try {
    const info: any = await app.client.conversations.info({ channel: channelId })
    return info?.channel?.creator || null
  } catch (err: any) {
    console.error('[brain.approvals] conversations.info failed:', err?.data?.error || err?.message)
    return null
  }
}

// ─── DM dispatch ───────────────────────────────────────────────────────────

interface BrainRow {
  id: string
  slack_channel: string | null
}

/**
 * DM the channel creator with a summary of pending candidates for a
 * single brain. Caller passes the brain row + creator slack user id.
 * Idempotent at the (brain, day) level by virtue of the candidates'
 * own status — pending rows already DM'd today aren't re-sent (a
 * second DM with the same content is annoying; the user can act on
 * the original).
 */
export async function dispatchApprovalDm(opts: {
  app: App
  brainRow: BrainRow
  approverSlackId: string
  candidates: PendingCandidateRow[]
}): Promise<{ posted: boolean; ts?: string }> {
  if (opts.candidates.length === 0) return { posted: false }

  const blocks: any[] = []
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:mag: I found ${opts.candidates.length} item${opts.candidates.length === 1 ? '' : 's'} outside <#${opts.brainRow.slack_channel}> that could improve the brain. *Nothing is added unless you approve.*`,
    },
  })
  for (const c of opts.candidates) {
    blocks.push({ type: 'divider' })
    const conf = c.similarity != null ? ` · sim ${Number(c.similarity).toFixed(2)}` : ''
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${truncate(c.summary || '(no summary)', 240)}*\n_${truncate(c.why_relevant || '', 200)}${conf}_\nSource: \`${c.source_ref || '?'}\``,
      },
    })
    blocks.push({
      type: 'actions',
      block_id: `brain_scavenger_${c.id}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: ACTION_APPROVE,
          value: String(c.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          action_id: ACTION_REJECT,
          value: String(c.id),
        },
      ],
    })
  }

  try {
    const dm: any = await opts.app.client.conversations.open({ users: opts.approverSlackId })
    const channelId = dm?.channel?.id
    if (!channelId) return { posted: false }
    const msg: any = await opts.app.client.chat.postMessage({
      channel: channelId,
      blocks,
      text: `Kit found ${opts.candidates.length} item${opts.candidates.length === 1 ? '' : 's'} outside the channel — approve to fold into the brain.`,
    })
    return { posted: true, ts: msg?.ts }
  } catch (err: any) {
    console.error('[brain.approvals] DM dispatch failed:', err?.data?.error || err?.message)
    return { posted: false }
  }
}

// ─── Apply / reject ────────────────────────────────────────────────────────

async function applyCandidate(app: App, candidate: PendingCandidateRow, approverSlackId: string): Promise<void> {
  const loaded = await getBrainById(candidate.brain_id)
  if (!loaded) throw new Error(`brain ${candidate.brain_id} not found`)
  const section = candidate.applied_section || 'Open decisions'

  await applyPatches({
    brainId: candidate.brain_id,
    patches: [
      {
        section,
        operation: 'add',
        text: truncate(candidate.summary || '(no summary)', 240),
        provenance: {
          src: candidate.source_ref || `doc:${candidate.source_doc_id || 'unknown'}`,
          by: approverSlackId,
          conf: candidate.similarity ?? undefined,
        },
      },
    ],
    author: approverSlackId,
  })

  // Refresh canvas + post in-channel notice so the team sees the update.
  if (loaded.row.slack_channel) {
    try {
      const fresh = await getBrainById(candidate.brain_id)
      if (fresh) {
        const handle = await createOrUpdateBrainCanvas({
          app,
          channelId: loaded.row.slack_channel,
          brain: fresh.brain,
          existingCanvasId: fresh.row.canvas_id,
        })
        if (handle.canvas_id !== fresh.row.canvas_id || handle.canvas_url !== fresh.row.canvas_url) {
          await setCanvasHandle(fresh.row.id, handle.canvas_id, handle.canvas_url)
        }
      }
      await app.client.chat.postMessage({
        channel: loaded.row.slack_channel,
        text: `:brain: <@${approverSlackId}> approved a piece of outside context — brain updated (§ ${section}).`,
      })
    } catch (err: any) {
      console.error('[brain.approvals] post-approval refresh failed:', err?.data?.error || err?.message)
    }
  }
}

// ─── Bolt action handlers ──────────────────────────────────────────────────

export function registerBrainApprovalHandlers(app: App): void {
  app.action(ACTION_APPROVE, async ({ ack, body, action, client, respond }) => {
    await ack()
    const id = Number((action as any).value)
    const userId = (body as any).user?.id
    if (!Number.isFinite(id) || !userId) return
    try {
      const candidate = await getCandidate(id)
      if (!candidate) {
        await respond({ replace_original: false, response_type: 'ephemeral', text: 'That candidate is no longer pending.' })
        return
      }
      // Claim BEFORE applying: a double click / approve-after-reject used to
      // re-apply the patch (duplicate bullets in the brain). Losing the
      // claim means someone already decided it.
      const section = candidate.applied_section || 'Open decisions'
      const claimed = await claimCandidate({ id, status: 'approved', approver: userId, appliedSection: section })
      if (!claimed) {
        await respond({ replace_original: false, response_type: 'ephemeral', text: 'That candidate is no longer pending.' })
        return
      }
      try {
        await applyCandidate(app, candidate, userId)
      } catch (applyErr) {
        // Apply failed after the claim — release so it can be retried.
        await releaseCandidate(id)
        throw applyErr
      }
      await updateDmBlocks({
        client,
        body: body as any,
        candidateId: id,
        replacement: { type: 'context', elements: [{ type: 'mrkdwn', text: `:white_check_mark: Approved by <@${userId}> — folded into § ${section}.` }] },
      })
    } catch (err: any) {
      console.error('[brain.approvals] approve handler failed:', err?.message || err)
      await respond({ replace_original: false, response_type: 'ephemeral', text: `Approve failed: ${err?.message || 'unknown error'}` })
    }
  })

  app.action(ACTION_REJECT, async ({ ack, body, action, client, respond }) => {
    await ack()
    const id = Number((action as any).value)
    const userId = (body as any).user?.id
    if (!Number.isFinite(id) || !userId) return
    try {
      const claimed = await claimCandidate({ id, status: 'rejected', approver: userId })
      if (!claimed) {
        await respond({ replace_original: false, response_type: 'ephemeral', text: 'That candidate is no longer pending.' })
        return
      }
      await updateDmBlocks({
        client,
        body: body as any,
        candidateId: id,
        replacement: { type: 'context', elements: [{ type: 'mrkdwn', text: `:x: Rejected by <@${userId}>.` }] },
      })
    } catch (err: any) {
      console.error('[brain.approvals] reject handler failed:', err?.message || err)
      await respond({ replace_original: false, response_type: 'ephemeral', text: `Reject failed: ${err?.message || 'unknown error'}` })
    }
  })
}

/**
 * After approve/reject, replace the candidate's actions row with a small
 * context block so the DM keeps a record of the decision but no longer
 * shows the buttons (which would no-op on second click).
 */
async function updateDmBlocks(opts: {
  client: any
  body: any
  candidateId: number
  replacement: any
}): Promise<void> {
  const channelId = opts.body.channel?.id || opts.body.container?.channel_id
  const ts = opts.body.message?.ts || opts.body.container?.message_ts
  const existingBlocks = opts.body.message?.blocks
  if (!channelId || !ts || !Array.isArray(existingBlocks)) return
  const targetBlockId = `brain_scavenger_${opts.candidateId}`
  const nextBlocks = existingBlocks.map((b: any) =>
    b.block_id === targetBlockId ? { ...opts.replacement, block_id: targetBlockId } : b,
  )
  try {
    await opts.client.chat.update({
      channel: channelId,
      ts,
      blocks: nextBlocks,
      text: 'Candidate decided.',
    })
  } catch (err: any) {
    console.error('[brain.approvals] chat.update failed:', err?.data?.error || err?.message)
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

/** Re-remind about still-pending candidates after this many days. */
const DM_REMIND_AFTER_DAYS = 7

/**
 * Convenience entry-point for the cron — given a workspace, walk every
 * brain with pending candidates and dispatch approval DMs.
 *
 * Idempotent per candidate: each is DM'd once (dm_sent_at stamp), with a
 * single re-remind after DM_REMIND_AFTER_DAYS. Safe to run hourly — the old
 * once-daily version re-sent identical DMs every day AND silently skipped a
 * day whenever the scan finished after the dispatch window.
 */
export async function dispatchAllPendingApprovals(opts: { app: App; workspaceId: string }): Promise<{ dms_sent: number; brains_with_pending: number; missing_creator: number }> {
  const { createAdminClient } = await import('../../../src/lib/supabase/admin')
  const sb = createAdminClient()
  const { data: brains } = await sb
    .from('brains')
    .select('id, slack_channel')
    .eq('workspace_id', opts.workspaceId)
  const remindCutoff = new Date(
    Date.now() - DM_REMIND_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  let dmsSent = 0
  let brainsWithPending = 0
  let missingCreator = 0
  for (const row of brains || []) {
    if (!row.slack_channel) continue
    const pending = await getPendingForBrain(row.id, { needingDmBefore: remindCutoff })
    if (pending.length === 0) continue
    brainsWithPending++
    const creator = await resolveChannelCreator(opts.app, row.slack_channel)
    if (!creator) {
      missingCreator++
      continue
    }
    const res = await dispatchApprovalDm({
      app: opts.app,
      brainRow: row as BrainRow,
      approverSlackId: creator,
      candidates: pending,
    })
    if (res.posted) {
      dmsSent++
      await markCandidatesDmSent(pending.map((c) => c.id))
    }
  }
  return { dms_sent: dmsSent, brains_with_pending: brainsWithPending, missing_creator: missingCreator }
}
