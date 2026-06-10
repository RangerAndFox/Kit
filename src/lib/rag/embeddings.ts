/**
 * OpenAI text-embedding-3-small wrapper for RAG.
 *
 * Returns 1536-dim float vectors. Batches up to 100 inputs per request
 * (OpenAI's limit; default is fine for most callers but expose it for
 * the backfill script which embeds 30+ docs at a time).
 *
 * Requires OPENAI_API_KEY in env. Throws on missing key — callers
 * upstream should guard with a flag or env check.
 */

const OPENAI_EMBED_MODEL = 'text-embedding-3-small'
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings'
const EMBED_DIMENSIONS = 1536

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set')
  return key
}

/**
 * Splits text into overlapping chunks for embedding. Unchanged from the
 * previous stub — used by callers that want chunk-level embedding for long
 * documents. Single-document callers (project summaries, notes) can pass the
 * whole text to `generateEmbedding` directly.
 */
export function chunkText(
  text: string,
  chunkSize: number = 1000,
  overlap: number = 200,
): string[] {
  if (!text || text.length === 0) return []
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    const chunk = text.substring(start, end)
    if (chunk.trim().length > 0) chunks.push(chunk)
    start = end - overlap
    if (start >= text.length - overlap) break
  }
  return chunks
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [vec] = await generateEmbeddings([text])
  return vec
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  // OpenAI hard limit: 2048 inputs per request, 8191 tokens per input.
  // We batch defensively at 100 to keep payloads small.
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100)
    const res = await fetch(OPENAI_EMBED_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: batch }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`OpenAI embeddings ${res.status}: ${detail}`)
    }
    const data = await res.json()
    for (const item of data.data || []) {
      const v = item?.embedding
      if (!Array.isArray(v) || v.length !== EMBED_DIMENSIONS) {
        throw new Error(`OpenAI returned unexpected embedding shape (expected ${EMBED_DIMENSIONS} dims, got ${v?.length ?? 'none'})`)
      }
      out.push(v)
    }
  }
  return out
}

export const EMBEDDING_DIMENSIONS = EMBED_DIMENSIONS
export const EMBEDDING_MODEL = OPENAI_EMBED_MODEL

/**
 * The Database types generate pgvector columns and RPC args as `string`, but
 * PostgREST also accepts a JSON array for vector input. This cast keeps the
 * wire format (a real array) while satisfying the generated types.
 */
export function asVectorParam(embedding: number[]): string {
  return embedding as unknown as string
}
