import { describe, it, expect } from 'vitest'

import { extractOrderedEmbeddings, chunkText } from '../../src/lib/rag/embeddings'

const v = (fill: number, dims = 3) => new Array(dims).fill(fill)

describe('extractOrderedEmbeddings', () => {
  it('reorders an out-of-order OpenAI response by index', () => {
    // OpenAI returned them shuffled — index is authoritative.
    const items = [
      { index: 2, embedding: v(2) },
      { index: 0, embedding: v(0) },
      { index: 1, embedding: v(1) },
    ]
    const out = extractOrderedEmbeddings(items, 3, 3)
    expect(out).toEqual([v(0), v(1), v(2)])
  })

  it('keeps an in-order response intact', () => {
    const items = [
      { index: 0, embedding: v(0) },
      { index: 1, embedding: v(1) },
    ]
    expect(extractOrderedEmbeddings(items, 2, 3)).toEqual([v(0), v(1)])
  })

  it('throws when the response is missing an input', () => {
    const items = [{ index: 0, embedding: v(0) }] // expected 2
    expect(() => extractOrderedEmbeddings(items, 2, 3)).toThrow(/missing embedding for index 1/)
  })

  it('throws on a wrong-dimension embedding', () => {
    const items = [{ index: 0, embedding: v(0, 2) }]
    expect(() => extractOrderedEmbeddings(items, 1, 3)).toThrow(/unexpected embedding shape/)
  })

  it('throws on an out-of-range / non-integer index', () => {
    expect(() => extractOrderedEmbeddings([{ index: 5, embedding: v(0) }], 1, 3)).toThrow(/invalid index/)
    expect(() => extractOrderedEmbeddings([{ index: 'x', embedding: v(0) }], 1, 3)).toThrow(/invalid index/)
  })
})

describe('chunkText', () => {
  it('chunks with overlap and covers the whole text', () => {
    const text = 'abcdefghij'.repeat(200) // 2000 chars
    const chunks = chunkText(text, 1000, 200)
    expect(chunks.length).toBeGreaterThan(1)
    // Overlap: chunk 2 starts 200 before chunk 1's end.
    expect(chunks[1].startsWith(text.slice(800, 810))).toBe(true)
  })

  it('returns a single chunk for short text and [] for empty', () => {
    expect(chunkText('short', 1000, 200)).toEqual(['short'])
    expect(chunkText('', 1000, 200)).toEqual([])
  })
})
