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

export interface TranscriptInput {
  id: string
  workspace_id: string
  project_id: string | null
  source: 'plaud' | 'manual' | 'granola'
  transcript: string
  participants: any[] | null
  start_time: string | null
  duration_seconds: number | null
  external_recording_id: string | null
  external_file_id: string | null
}

export function composeTranscriptTitle(t: TranscriptInput): string {
  const date = t.start_time ? new Date(t.start_time).toISOString().slice(0, 10) : 'unknown date'
  const sourceLabel = t.source === 'plaud' ? 'Plaud' : t.source === 'granola' ? 'Granola' : 'Manual'
  // Try to derive a meaningful label from participants
  const peopleNames = (t.participants || [])
    .map((p: any) => p?.displayName || p?.name || p?.email || '')
    .filter(Boolean)
    .slice(0, 3)
  const peopleSuffix = peopleNames.length > 0 ? ` · ${peopleNames.join(', ')}` : ''
  return `${sourceLabel} transcript · ${date}${peopleSuffix}`
}

export async function embedTranscript(t: TranscriptInput): Promise<{ documentIds: string[]; chunks: number }> {
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
    visibilityTier: 'team',
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
  return { documentIds: results.map((r) => r.documentId), chunks: results.length }
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
      // Skip if we already have a project_documents row for this transcript.
      const { data: existing } = await sb
        .from('project_documents')
        .select('id')
        .eq('doc_type', 'call_transcript')
        .filter('metadata->>call_transcripts_id', 'eq', t.id)
        .limit(1)
        .maybeSingle()
      if (existing) {
        skipped++
        continue
      }
      await embedTranscript(t as any)
      embedded++
    } catch (err: any) {
      console.error(`[transcript-embed] failed for ${t.id}: ${err.message}`)
      failed++
    }
  }
  return { embedded, skipped, failed }
}
