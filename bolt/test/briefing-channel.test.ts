import { describe, it, expect } from 'vitest'

import {
  slugifyName,
  briefingChannelNameCandidates,
} from '../../src/lib/agent/briefing-channel'

describe('slugifyName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyName('Erin Serletic')).toBe('erin-serletic')
  })

  it('strips punctuation and collapses separators', () => {
    expect(slugifyName("O'Brien,  Jr.")).toBe('o-brien-jr')
  })

  it('trims leading/trailing dashes', () => {
    expect(slugifyName('  Ted!  ')).toBe('ted')
  })

  it('returns empty string for empty/undefined input', () => {
    expect(slugifyName('')).toBe('')
    expect(slugifyName(undefined as any)).toBe('')
  })

  it('caps length at 60 chars', () => {
    expect(slugifyName('a'.repeat(200)).length).toBe(60)
  })
})

describe('briefingChannelNameCandidates', () => {
  it('offers a readable name, an id-suffixed fallback, then a unique id name', () => {
    expect(briefingChannelNameCandidates('Steve', 'U4CA7HXT9')).toEqual([
      'kit-briefings-steve',
      'kit-briefings-steve-hxt9',
      'kit-briefings-u4ca7hxt9',
    ])
  })

  it('falls back to the id-only name when there is no usable name', () => {
    expect(briefingChannelNameCandidates('', 'U4CA7HXT9')).toEqual([
      'kit-briefings-u4ca7hxt9',
    ])
    expect(briefingChannelNameCandidates(null, 'UJ61GRUK1')).toEqual([
      'kit-briefings-uj61gruk1',
    ])
  })

  it('every candidate is a valid Slack channel name (lowercase, <=80, safe chars)', () => {
    const names = briefingChannelNameCandidates('Jean-Luc Picard!!!', 'UABCDEFGH')
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(80)
      expect(n).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('dedupes when the id-suffixed name would equal the id-only name', () => {
    // A name that slugifies away entirely just yields the id-only candidate.
    const names = briefingChannelNameCandidates('!!!', 'UXYZ')
    expect(names).toEqual(['kit-briefings-uxyz'])
    // No duplicates ever.
    expect(new Set(names).size).toBe(names.length)
  })
})
