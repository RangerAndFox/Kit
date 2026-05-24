// @ts-nocheck
/**
 * Semantic search via the public.match_documents Postgres RPC.
 *
 * The RPC does real pgvector cosine search (ORDER BY embedding <=> query)
 * and returns rows already filtered by workspace_id + project_id +
 * visibility tier. We just generate the query embedding, call the RPC,
 * and return its results.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding } from './embeddings'

export interface SearchResult {
  documentId: string
  title: string
  content: string
  docType: string
  sourceUrl: string | null
  similarity: number
  metadata: Record<string, unknown> | null
}

export interface SearchOptions {
  workspaceId?: string | null
  projectId?: string | null
  limit?: number
}

export async function searchDocuments(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  if (!query || query.trim().length === 0) return []
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10))

  const embedding = await generateEmbedding(query)
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('match_documents', {
    query_embedding: embedding,
    match_count: limit,
    filter_workspace_id: opts.workspaceId ?? null,
    filter_project_id: opts.projectId ?? null,
  })
  if (error) {
    throw new Error(`match_documents RPC failed: ${error.message}`)
  }

  return (data || []).map((row: any) => ({
    documentId: row.id,
    title: row.title,
    content: row.content,
    docType: row.doc_type,
    sourceUrl: row.source_url ?? null,
    similarity: typeof row.similarity === 'number' ? row.similarity : 0,
    metadata: row.metadata ?? null,
  }))
}

/**
 * Pack search results into a prompt-friendly context string with citation
 * tags. Caller supplies a max-char budget; we trim from the lowest-similarity
 * results first.
 */
export function buildContext(results: SearchResult[], maxChars = 16_000): string {
  if (results.length === 0) return ''
  const parts: string[] = []
  let used = 0
  for (const r of results) {
    const block = `[${r.title}${r.docType ? ` · ${r.docType}` : ''}${r.similarity ? ` · ${r.similarity.toFixed(2)}` : ''}]\n${r.content}\n\n`
    if (used + block.length > maxChars) {
      const remaining = maxChars - used
      if (remaining > 200) parts.push(block.slice(0, remaining))
      break
    }
    parts.push(block)
    used += block.length
  }
  return parts.join('')
}
