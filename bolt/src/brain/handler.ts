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
import { getBrainByChannel, applyPatches, getBrainById, setCanvasHandle } from '../../../src/lib/brain/store'
import { createOrUpdateBrainCanvas } from '../../../src/lib/brain/canvas'
import {
  proposePatches,
  filterForAutoApply,
  classifySignal,
  type BrainSignal,
} from '../../../src/lib/brain/writer'
import { checkMessageForMistakes, recordKitAction } from '../../../src/lib/brain/flagger'

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

  // Run writer + mistake-catch in parallel against the SAME pre-patch
  // brain state. They're independent: writer proposes new patches;
  // mistake-catch only flags contradictions with existing canonical
  // facts. Phase 4 §3.2.
  const [writerResult, mistakeResult] = await Promise.allSettled([
    proposePatches({ brain: loaded.brain, signal }),
    checkMessageForMistakes({ brain: loaded.brain, messageText: args.messageText }),
  ])

  // ── Apply writer patches ─────────────────────────────────
  let patchesApplied = false
  if (writerResult.status === 'fulfilled') {
    const result = writerResult.value
    if (result.changes_understanding && result.patches.length > 0) {
      const filtered = filterForAutoApply({ result, signal })
      if (filtered.skipped_low_conf.length > 0) {
        console.log(
          `[brain.ingest] ${loaded.row.id}: skipped ${filtered.skipped_low_conf.length} low-confidence patches`,
          filtered.skipped_low_conf.map((p) => `${p.section}: ${p.text.slice(0, 60)} (${p.confidence})`),
        )
      }
      if (filtered.applied.length > 0) {
        try {
          await applyPatches({
            brainId: loaded.row.id,
            patches: filtered.applied,
            author: args.userId,
          })
          console.log(
            `[brain.ingest] ${loaded.row.id}: applied ${filtered.applied.length} patch(es) from ${args.userId}`,
          )
          patchesApplied = true
        } catch (err: any) {
          console.error('[brain.ingest] applyPatches failed:', err.message)
        }
      }
    }
  } else {
    console.error('[brain.ingest] proposePatches failed:', writerResult.reason?.message || writerResult.reason)
  }

  // ── Post any high-confidence mistake catches in-thread ──
  if (mistakeResult.status === 'fulfilled') {
    const mistakes = mistakeResult.value.catches.filter((c) => c.confidence >= 0.85)
    for (const m of mistakes) {
      const sourceTag = m.provenance?.src ? `\n_Source: \`${m.provenance.src}\` (${m.evidence_section})_` : ''
      try {
        await args.app.client.chat.postMessage({
          channel: args.channelId,
          thread_ts: args.threadTs || args.messageTs,
          text: `:eyes: ${m.suggestion}${sourceTag}`,
        })
        console.log(
          `[brain.ingest] ${loaded.row.id}: posted mistake-catch (conf ${m.confidence.toFixed(2)}): ${m.incorrect} vs ${m.canonical}`,
        )
      } catch (err: any) {
        console.error('[brain.ingest] mistake-catch post failed:', err?.data?.error || err?.message)
      }
      await recordKitAction({
        workspaceId,
        projectId: loaded.row.project_id,
        type: 'brain_mistake_catch',
        title: `Mistake catch: ${shortText(m.incorrect, 60)} → ${shortText(m.canonical, 60)}`,
        description: m.suggestion,
        payload: {
          brain_id: loaded.row.id,
          channel_id: args.channelId,
          message_ts: args.messageTs,
          canonical: m.canonical,
          incorrect: m.incorrect,
          evidence_section: m.evidence_section,
        },
        confidence: m.confidence,
        dedupKey: `${loaded.row.id}:${args.messageTs}:${simpleStableHash(m.canonical)}`,
      })
    }
  } else {
    console.error('[brain.ingest] mistake-catch failed:', mistakeResult.reason?.message || mistakeResult.reason)
  }

  // ── Refresh canvas if we touched the brain ──────────────
  if (patchesApplied) {
    await refreshCanvasAfterPatch(args.app, loaded.row.id, args.channelId)
  }
}

function shortText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

function simpleStableHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

export interface IngestNoteArgs {
  app: App
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
    await refreshCanvasAfterPatch(args.app, loaded.row.id, args.channelId)
  } catch (err: any) {
    console.error('[brain.ingest.note] applyPatches failed:', err.message)
  }
}

/**
 * Re-render the brain's Slack Canvas after a patch lands. Without this,
 * the markdown updates in Supabase but the canvas tab the team is looking
 * at stays frozen at the seeded version. Best-effort: a canvas API
 * failure must never bubble up — the patch itself already succeeded.
 */
async function refreshCanvasAfterPatch(app: App, brainId: string, channelId: string): Promise<void> {
  try {
    const fresh = await getBrainById(brainId)
    if (!fresh) return
    const handle = await createOrUpdateBrainCanvas({
      app,
      channelId,
      brain: fresh.brain,
      existingCanvasId: fresh.row.canvas_id,
    })
    if (handle.canvas_id !== fresh.row.canvas_id || handle.canvas_url !== fresh.row.canvas_url) {
      await setCanvasHandle(brainId, handle.canvas_id, handle.canvas_url)
    }
  } catch (err: any) {
    console.error('[brain.ingest] canvas refresh failed:', err?.data?.error || err?.message || err)
  }
}

function tsToIso(ts: string): string {
  // Slack ts is "<unix>.<microseconds>"
  const sec = parseFloat(ts)
  if (!Number.isFinite(sec)) return new Date().toISOString()
  return new Date(sec * 1000).toISOString()
}
