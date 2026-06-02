// @ts-nocheck
/**
 * Notes handler — saves freeform notes into project_documents (doc_type='note')
 * so they're embedded and surface in studio_knowledge semantic search.
 *
 * Project resolution priority:
 *   1. Explicit hint from "note for <project>: ..." pattern → fuzzy match.
 *   2. Current channel's linked project (if any).
 *   3. Ask the user to specify.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { ingestDocument } from '../../../src/lib/rag/ingest'
import { parseNoteIntent } from './keyword'
import { handleBrainIngestNote } from '../brain/handler'

interface ResolvedProject {
  id: string
  workspace_id: string
  name: string | null
  project_code: string | null
}

async function resolveProjectForChannel(channelId: string): Promise<ResolvedProject | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('id, workspace_id, name, project_code')
    .or(`external_links->>slack_id.eq.${channelId},external_links->>slack_channel_id.eq.${channelId},slack_channel_id.eq.${channelId}`)
    .maybeSingle()
  if (!data?.id) return null
  return data as ResolvedProject
}

async function fuzzyResolveProject(hint: string): Promise<{ matches: ResolvedProject[] }> {
  const sb = createAdminClient()
  // Exact project_code first
  const { data: exact } = await sb
    .from('projects')
    .select('id, workspace_id, name, project_code')
    .eq('project_code', hint)
    .maybeSingle()
  if (exact) return { matches: [exact as ResolvedProject] }

  // Fuzzy fallback
  const { data: fuzzy } = await sb
    .from('projects')
    .select('id, workspace_id, name, project_code')
    .or(`name.ilike.%${hint}%,client.ilike.%${hint}%,project_code.ilike.%${hint}%`)
    .limit(5)
  return { matches: (fuzzy as ResolvedProject[]) || [] }
}

export async function handleNoteMessage(opts: {
  app: App
  channelId: string
  userId: string
  text: string
  threadTs?: string
}): Promise<boolean> {
  const { app, channelId, userId, text } = opts
  const intent = parseNoteIntent(text)
  if (!intent) return false
  if (!intent.body || intent.body.length < 3) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: ":thinking_face: I caught a note trigger but the body was empty. Try `note for <project>: <your note>`.",
    })
    return true
  }

  let project: ResolvedProject | null = null

  if (intent.projectHint) {
    const { matches } = await fuzzyResolveProject(intent.projectHint)
    if (matches.length === 0) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `:thinking_face: I couldn't find a project matching "${intent.projectHint}". Try the exact project code (like \`2655-Nike\`) or check spelling.`,
      })
      return true
    }
    if (matches.length > 1) {
      const list = matches
        .map((m) => `• \`${m.project_code || '—'}\` — *${m.name || '(unnamed)'}*`)
        .join('\n')
      await app.client.chat.postMessage({
        channel: channelId,
        text: `:thinking_face: Multiple projects matched "${intent.projectHint}". Which one?\n${list}\n\nReply with \`note for <project_code>: <your note>\` to disambiguate.`,
      })
      return true
    }
    project = matches[0]
  } else {
    project = await resolveProjectForChannel(channelId)
    if (!project) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ":thinking_face: This channel isn't linked to a Kit project. Try `note for <project name or code>: <your note>` to attach the note explicitly.",
      })
      return true
    }
  }

  // Title for the note doc. Includes a short timestamp so multiple notes
  // on the same project don't collide on upsertDocument's title-based
  // dedupe (which is fine — these are intentional inserts, not idempotent
  // backfills).
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ')
  const projectLabel = project.project_code || project.name || project.id.slice(0, 8)
  const title = `Note · ${projectLabel} · ${dateStr}`

  try {
    const { documentId } = await ingestDocument({
      workspaceId: project.workspace_id,
      projectId: project.id,
      docType: 'note',
      title,
      content: intent.body,
      visibilityTier: 'team',
      metadata: {
        captured_via: 'slack',
        captured_by_slack_user_id: userId,
        captured_at: now.toISOString(),
        channel_id: channelId,
        project_code: project.project_code,
        project_name: project.name,
      },
    })

    await app.client.chat.postMessage({
      channel: channelId,
      text:
        `:writing_hand: Note saved to *${project.name || project.project_code || project.id.slice(0, 8)}*. ` +
        `It's now searchable — ask me anything about ${project.project_code || project.name || 'this project'} and I'll pull it in.`,
    })

    // Fire-and-forget brain ingest. The note has already been saved + embedded
    // into RAG; this additional path lets the brain propose structured patches
    // (decisions, watchlist items, glossary entries) from the note body.
    handleBrainIngestNote({
      channelId,
      userId,
      noteText: intent.body,
      noteTitle: title,
      projectId: project.id,
      workspaceId: project.workspace_id,
    }).catch((err) => console.error('[notes] brain ingest failed:', err.message || err))

    return true
  } catch (err: any) {
    const detail = err?.data?.error || err?.message || String(err)
    console.error('[notes] save failed:', detail)
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:warning: Couldn't save the note: ${detail}. (Confirm OPENAI_API_KEY is set in Railway — the note has to be embedded to be searchable.)`,
    })
    return true
  }
}
