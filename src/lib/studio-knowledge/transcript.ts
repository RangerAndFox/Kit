/**
 * Embed a call transcript into the RAG store (project_documents).
 *
 * Transcripts can be long, so we use ingestLongDocument which chunks at
 * ~1500 chars with 300-char overlap and embeds each chunk as its own row.
 * All chunks share project_id and doc_type='call_transcript' so they're
 * grouped on retrieval.
 */

import { ingestLongDocument } from '../rag/ingest'
import { createAdminClient } from '../supabase/admin'
import { sanitizeTranscriptForSharedSurface } from '../privacy/shared-surface'

export interface TranscriptInput {
  id: string
  workspace_id: string
  project_id: string | null
  source: 'plaud' | 'manual' | 'granola' | 'drive'
  transcript: string
  participants: any[] | null
  start_time: string | null
  duration_seconds: number | null
  external_recording_id: string | null
  external_file_id: string | null
}

export function transcriptVisibilityTier(t: Pick<TranscriptInput, 'project_id' | 'source'>): 'team' | 'founder' {
  // Plaud and its Drive/Zapier intake can contain personal conversations even
  // when a project matcher finds a plausible project. The raw source therefore
  // remains founder-only unconditionally. Project-matched calls get a separate,
  // deterministic redacted derivative below for team retrieval.
  if (t.source === 'plaud' || t.source === 'drive') return 'founder'
  return 'team'
}

export function composeTranscriptTitle(t: TranscriptInput): string {
  const date = t.start_time ? new Date(t.start_time).toISOString().slice(0, 10) : 'unknown date'
  const sourceLabel =
    t.source === 'plaud'
      ? 'Plaud'
      : t.source === 'granola'
        ? 'Granola'
        : t.source === 'drive'
          ? 'Call'
          : 'Manual'
  // Try to derive a meaningful label from participants
  const peopleNames = (t.participants || [])
    .map((p: any) => p?.displayName || p?.name || p?.email || '')
    .filter(Boolean)
    .slice(0, 3)
  const peopleSuffix = peopleNames.length > 0 ? ` · ${peopleNames.join(', ')}` : ''
  return `${sourceLabel} transcript · ${date}${peopleSuffix}`
}

export async function embedTranscript(t: TranscriptInput): Promise<{ documentIds: string[]; chunks: number; safeChunks: number }> {
  if (!t.transcript || t.transcript.trim().length === 0) {
    throw new Error('embedTranscript: transcript text is empty')
  }
  const title = composeTranscriptTitle(t)
  const results = await ingestLongDocument({
    workspaceId: t.workspace_id,
    projectId: t.project_id,
    docType: 'call_transcript',
    title,
    content: t.transcript,
    visibilityTier: transcriptVisibilityTier(t),
    metadata: {
      source: t.source,
      external_recording_id: t.external_recording_id,
      external_file_id: t.external_file_id,
      duration_seconds: t.duration_seconds,
      start_time: t.start_time,
      participants: t.participants,
      call_transcripts_id: t.id,
    },
  })

  let safeResults: Array<{ documentId: string }> = []
  if (t.project_id && (t.source === 'plaud' || t.source === 'drive')) {
    const safeText = sanitizeTranscriptForSharedSurface(t.transcript)
    // Empty is the safe outcome when every line contains restricted material.
    if (safeText) {
      safeResults = await ingestLongDocument({
        workspaceId: t.workspace_id,
        projectId: t.project_id,
        docType: 'call_transcript_safe',
        title: `${title} · shared-safe`,
        content: safeText,
        visibilityTier: 'team',
        metadata: {
          source: t.source,
          redacted_for_shared_surfaces: true,
          call_transcripts_id: t.id,
          start_time: t.start_time,
        },
      })
    }
  }
  return {
    documentIds: [...results, ...safeResults].map((r) => r.documentId),
    chunks: results.length,
    safeChunks: safeResults.length,
  }
}

/**
 * Backfill: embed any call_transcripts rows where ingest_status='ingested'
 * but no corresponding project_documents entry exists yet. Useful for
 * re-runs after schema or chunking changes.
 *
 * Match heuristic: any project_documents row with doc_type='call_transcript'
 * and metadata->>'call_transcripts_id' equal to the transcript row id
 * means it's already embedded.
 */
export async function backfillTranscriptsIntoRag(workspaceId: string): Promise<{ embedded: number; skipped: number; failed: number }> {
  const sb = createAdminClient()
  const { data: rows, error } = await sb
    .from('call_transcripts')
    .select('id, workspace_id, project_id, source, transcript, participants, start_time, duration_seconds, external_recording_id, external_file_id')
    .eq('workspace_id', workspaceId)
    .eq('ingest_status', 'ingested')
    .not('transcript', 'is', null)
  if (error) throw new Error(`backfillTranscriptsIntoRag: ${error.message}`)

  let embedded = 0
  let skipped = 0
  let failed = 0

  for (const t of rows || []) {
    try {
      // A complete embedding has a raw source row and, for matched Plaud/Drive
      // calls, a separate shared-safe row. Missing derivatives are repaired.
      const { data: existing } = await sb
        .from('project_documents')
        .select('id, doc_type')
        .in('doc_type', ['call_transcript', 'call_transcript_safe'])
        .filter('metadata->>call_transcripts_id', 'eq', t.id)
      const hasRaw = (existing || []).some((doc: any) => doc.doc_type === 'call_transcript')
      const needsSafe = Boolean(t.project_id) && (t.source === 'plaud' || t.source === 'drive')
      const hasSafe = (existing || []).some((doc: any) => doc.doc_type === 'call_transcript_safe')
      if (hasRaw && (!needsSafe || hasSafe)) {
        skipped++
        continue
      }
      await sb
        .from('project_documents')
        .delete()
        .in('doc_type', ['call_transcript', 'call_transcript_safe'])
        .filter('metadata->>call_transcripts_id', 'eq', t.id)
      await embedTranscript(t as any)
      embedded++
    } catch (err: any) {
      console.error(`[transcript-embed] failed for ${t.id}: ${err.message}`)
      failed++
    }
  }
  return { embedded, skipped, failed }
}
