// @ts-nocheck
/**
 * Brain ingest hook — turns Slack signals into brain patches.
 *
 * Called from:
 *   - bolt/src/handlers/messages.ts (every non-bot channel message in
 *     channels that have a linked project)
 *   - bolt/src/notes/handler.ts (after a note has been saved)
 *
 * Cheap heuristic gate first, then Claude Haiku for the actual semantic
 * decision. High-confidence patches auto-apply; low-confidence are
 * logged for now (Phase 3 will surface them as "I learned X — correct
 * me?" reactions).
 *
 * Spec: KIT-BRAIN-SPEC.md §3.0, §4
 */

import type { App } from '@slack/bolt'
import { getBrainByChannel, applyPatches } from '../../../src/lib/brain/store'
import {
  proposePatches,
  filterForAutoApply,
  classifySignal,
  type BrainSignal,
} from '../../../src/lib/brain/writer'

// In-memory dedup so the same (channel, ts) doesn't process twice within
// a short window (Slack will sometimes re-deliver events). Bounded by a
// simple FIFO cap.
const SEEN: Set<string> = new Set()
const SEEN_ORDER: string[] = []
const SEEN_CAP = 2000

function markSeen(key: string): boolean {
  if (SEEN.has(key)) return true
  SEEN.add(key)
  SEEN_ORDER.push(key)
  if (SEEN_ORDER.length > SEEN_CAP) {
    const evict = SEEN_ORDER.shift()
    if (evict) SEEN.delete(evict)
  }
  return false
}

export interface IngestMessageArgs {
  app: App
  channelId: string
  userId: string
  messageText: string
  messageTs: string
  threadTs?: string
  workspaceId?: string
}

/**
 * Channel message ingest. Resolves the channel's brain (silently no-ops
 * if no brain exists for the channel), runs the writer, applies high-
 * confidence patches. Fire-and-forget from the message handler.
 */
export async function handleBrainIngestMessage(args: IngestMessageArgs): Promise<void> {
  const workspaceId = args.workspaceId || process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) return

  // Cheap pre-classifier — most channel chatter exits here without a DB hit.
  const signal: BrainSignal = {
    kind: 'message',
    text: args.messageText,
    sourceRef: `thread:${args.channelId}/${args.threadTs || args.messageTs}`,
    author: args.userId,
    occurredAt: tsToIso(args.messageTs),
    channelId: args.channelId,
  }
  if (classifySignal(signal)) return

  // Per-message dedup so a redelivery doesn't double-write
  const dedupKey = `${args.channelId}:${args.messageTs}`
  if (markSeen(dedupKey)) return

  let loaded
  try {
    loaded = await getBrainByChannel(workspaceId, args.channelId)
  } catch (err: any) {
    console.error('[brain.ingest] getBrainByChannel failed:', err.message)
    return
  }
  if (!loaded) return  // no brain for this channel — Phase 1 channels only get brains on /kit brain

  let result
  try {
    result = await proposePatches({ brain: loaded.brain, signal })
  } catch (err: any) {
    console.error('[brain.ingest] proposePatches failed:', err.message)
    return
  }
  if (!result.changes_understanding || result.patches.length === 0) return

  const filtered = filterForAutoApply({ result, signal })
  if (filtered.skipped_low_conf.length > 0) {
    console.log(
      `[brain.ingest] ${loaded.row.id}: skipped ${filtered.skipped_low_conf.length} low-confidence patches`,
      filtered.skipped_low_conf.map((p) => `${p.section}: ${p.text.slice(0, 60)} (${p.confidence})`),
    )
  }
  if (filtered.applied.length === 0) return

  try {
    await applyPatches({
      brainId: loaded.row.id,
      patches: filtered.applied,
      author: args.userId,
    })
    console.log(
      `[brain.ingest] ${loaded.row.id}: applied ${filtered.applied.length} patch(es) from ${args.userId}`,
    )
  } catch (err: any) {
    console.error('[brain.ingest] applyPatches failed:', err.message)
  }
}

export interface IngestNoteArgs {
  channelId: string
  userId: string
  noteText: string
  noteTitle?: string
  projectId?: string | null
  workspaceId?: string
}

/**
 * Note ingest. Notes go through the same writer pipeline but with a
 * different sourceRef so the brain's `Sources:` block can link back to
 * the note when Phase 3 ships sourced answers.
 */
export async function handleBrainIngestNote(args: IngestNoteArgs): Promise<void> {
  const workspaceId = args.workspaceId || process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) return

  const signal: BrainSignal = {
    kind: 'note',
    text: args.noteText,
    sourceRef: `note:${(args.noteTitle || args.noteText.slice(0, 40)).replace(/\s+/g, ' ').trim()}`,
    author: args.userId,
    occurredAt: new Date().toISOString(),
    channelId: args.channelId,
  }
  if (classifySignal(signal)) return

  let loaded
  try {
    loaded = await getBrainByChannel(workspaceId, args.channelId)
  } catch (err: any) {
    console.error('[brain.ingest.note] getBrainByChannel failed:', err.message)
    return
  }
  if (!loaded) return

  let result
  try {
    result = await proposePatches({ brain: loaded.brain, signal })
  } catch (err: any) {
    console.error('[brain.ingest.note] proposePatches failed:', err.message)
    return
  }
  if (!result.changes_understanding || result.patches.length === 0) return

  const filtered = filterForAutoApply({ result, signal })
  if (filtered.applied.length === 0) return

  try {
    await applyPatches({
      brainId: loaded.row.id,
      patches: filtered.applied,
      author: args.userId,
    })
    console.log(`[brain.ingest.note] ${loaded.row.id}: applied ${filtered.applied.length} patch(es)`)
  } catch (err: any) {
    console.error('[brain.ingest.note] applyPatches failed:', err.message)
  }
}

function tsToIso(ts: string): string {
  // Slack ts is "<unix>.<microseconds>"
  const sec = parseFloat(ts)
  if (!Number.isFinite(sec)) return new Date().toISOString()
  return new Date(sec * 1000).toISOString()
}
