/**
 * RAG document ingestion — writes a single project_documents row per
 * document with an inline embedding. The live schema does NOT have a
 * separate document_chunks table; embeddings are per-document.
 *
 * For very long documents (transcripts), chunk first and ingest each
 * chunk as its own row with the same project_id + doc_type — that path
 * lives in `ingestLongDocument` below.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/supabase'
import { generateEmbedding, generateEmbeddings, chunkText, asVectorParam } from './embeddings'

export interface IngestOptions {
  workspaceId: string
  projectId?: string | null
  docType: string
  title: string
  content: string
  sourceUrl?: string | null
  visibilityTier?: 'team' | 'producer' | 'freelancer' | 'founder'
  metadata?: Record<string, unknown>
}

export interface IngestResult {
  documentId: string
}

export async function ingestDocument(opts: IngestOptions): Promise<IngestResult> {
  const sb = createAdminClient()
  if (!opts.content || opts.content.trim().length === 0) {
    throw new Error('ingestDocument: content is empty')
  }
  const embedding = await generateEmbedding(opts.content)

  const { data, error } = await sb
    .from('project_documents')
    .insert({
      workspace_id: opts.workspaceId,
      project_id: opts.projectId ?? null,
      doc_type: opts.docType,
      title: opts.title,
      content: opts.content,
      source_url: opts.sourceUrl ?? null,
      embedding: asVectorParam(embedding),
      metadata: (opts.metadata ?? null) as Json,
      visibility_tier: opts.visibilityTier ?? 'team',
      indexed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) throw new Error(`ingestDocument insert failed: ${error.message}`)
  return { documentId: data!.id }
}

/**
 * Upsert variant — replaces an existing row when (workspace_id, doc_type, title)
 * collides. Used by backfill paths that re-run periodically and shouldn't
 * accumulate dupes. Caller-provided uniqueness; the table itself has no
 * unique constraint on those columns (yet).
 */
export async function upsertDocument(opts: IngestOptions): Promise<IngestResult> {
  const sb = createAdminClient()
  if (!opts.content || opts.content.trim().length === 0) {
    throw new Error('upsertDocument: content is empty')
  }

  // Find existing match
  const { data: existing } = await sb
    .from('project_documents')
    .select('id')
    .eq('workspace_id', opts.workspaceId)
    .eq('doc_type', opts.docType)
    .eq('title', opts.title)
    .maybeSingle()

  const embedding = await generateEmbedding(opts.content)

  if (existing?.id) {
    const { error } = await sb
      .from('project_documents')
      .update({
        project_id: opts.projectId ?? null,
        content: opts.content,
        source_url: opts.sourceUrl ?? null,
        embedding: asVectorParam(embedding),
        metadata: (opts.metadata ?? null) as Json,
        visibility_tier: opts.visibilityTier ?? 'team',
        indexed_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (error) throw new Error(`upsertDocument update failed: ${error.message}`)
    return { documentId: existing.id }
  }

  return ingestDocument(opts)
}

/**
 * For long documents (transcripts, briefs > ~2000 chars), chunk and ingest
 * each chunk as its own project_documents row. Chunks share project_id and
 * doc_type; title is suffixed with " (chunk N/M)".
 */
export async function ingestLongDocument(opts: IngestOptions): Promise<IngestResult[]> {
  const chunks = chunkText(opts.content, 1500, 300)
  if (chunks.length <= 1) {
    return [await ingestDocument(opts)]
  }
  const embeddings = await generateEmbeddings(chunks)
  const sb = createAdminClient()
  const rows = chunks.map((c, i) => ({
    workspace_id: opts.workspaceId,
    project_id: opts.projectId ?? null,
    doc_type: opts.docType,
    title: `${opts.title} (chunk ${i + 1}/${chunks.length})`,
    content: c,
    source_url: opts.sourceUrl ?? null,
    embedding: asVectorParam(embeddings[i]),
    metadata: { ...(opts.metadata ?? {}), chunk_index: i, chunk_total: chunks.length } as Json,
    visibility_tier: opts.visibilityTier ?? 'team',
    indexed_at: new Date().toISOString(),
  }))
  const { data, error } = await sb
    .from('project_documents')
    .insert(rows)
    .select('id')
  if (error) throw new Error(`ingestLongDocument insert failed: ${error.message}`)
  return (data || []).map((r) => ({ documentId: r.id }))
}

export async function deleteDocument(documentId: string): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb.from('project_documents').delete().eq('id', documentId)
  if (error) throw new Error(`deleteDocument failed: ${error.message}`)
}
