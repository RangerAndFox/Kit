import { expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ embedding: vi.fn(), db: vi.fn() }))
vi.mock('../../src/lib/rag/embeddings', () => ({ generateEmbedding: io.embedding, asVectorParam: (x: unknown) => x }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: io.db }))
import { searchDocuments } from '../../src/lib/rag/query'
import { brainFirstRetrieve } from '../../src/lib/brain/retrieve'

it('missing workspace fails before embedding, lookup, or retrieval', async () => {
  await expect(searchDocuments('budget', { workspaceId: '', visibilityTiers: ['team'] })).rejects.toThrow('workspace')
  await expect(brainFirstRetrieve({ query: 'budget', workspaceId: '', brainId: 'other-tenant' })).rejects.toThrow('workspace')
  expect(io.embedding).not.toHaveBeenCalled()
  expect(io.db).not.toHaveBeenCalled()
})
