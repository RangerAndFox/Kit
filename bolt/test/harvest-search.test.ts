import { describe, it, expect } from 'vitest'

import { rankProjects, scoreProjectMatch } from '../../src/lib/harvest/search'

// Mirrors the real account: legacy composite names alongside the new
// code/client/name breakdown.
const PROJECTS = [
  { name: '2611 | Microsoft | AI in Meetings (Meera)', code: '', client: { id: 1, name: 'Microsoft' } },
  { name: 'Magic Quadrant', code: '2626-MSFT', client: { id: 2, name: 'MSFT' } },
  { name: 'Rainforest Expo', code: '2628-Crunchyroll', client: { id: 3, name: 'Crunchyroll' } },
  { name: 'Ignite Video Updates', code: '2609-Microsoft', client: { id: 1, name: 'Microsoft' } },
  { name: 'Football', code: '2627-HBCUGo', client: { id: 4, name: 'HBCUGo' } },
]

describe('rankProjects', () => {
  it('finds a project by bare number code, even in a legacy composite name', () => {
    expect(rankProjects('2611', PROJECTS).map((p) => p.name)).toEqual([
      '2611 | Microsoft | AI in Meetings (Meera)',
    ])
  })

  it('finds a project by code inside a sentence', () => {
    expect(rankProjects('I worked on 2611', PROJECTS).map((p) => p.name)).toEqual([
      '2611 | Microsoft | AI in Meetings (Meera)',
    ])
  })

  it('finds by code in the code field', () => {
    expect(rankProjects('2626', PROJECTS).map((p) => p.name)).toEqual(['Magic Quadrant'])
  })

  it('tolerates spacing differences in client names ("Crunchy roll")', () => {
    expect(rankProjects('crunchy roll', PROJECTS).map((p) => p.name)).toEqual(['Rainforest Expo'])
  })

  it('resolves underscore/hyphen mashups ("2611_MSFT_AI-in-Meetings")', () => {
    expect(rankProjects('2611_MSFT_AI-in-Meetings', PROJECTS).map((p) => p.name)).toEqual([
      '2611 | Microsoft | AI in Meetings (Meera)',
    ])
  })

  it('finds by project name', () => {
    expect(rankProjects('magic quadrant', PROJECTS).map((p) => p.name)).toEqual(['Magic Quadrant'])
  })

  it('finds by a distinctive keyword inside the name', () => {
    expect(rankProjects('meera', PROJECTS).map((p) => p.name)).toEqual([
      '2611 | Microsoft | AI in Meetings (Meera)',
    ])
  })

  it('returns multiple candidates when no project dominates', () => {
    const withTwin = [...PROJECTS, { name: 'Ignite Keynote', code: '2650-Microsoft', client: { id: 1, name: 'Microsoft' } }]
    const results = rankProjects('ignite', withTwin).map((p) => p.name)
    expect(results).toHaveLength(2)
    expect(results).toContain('Ignite Video Updates')
    expect(results).toContain('Ignite Keynote')
  })

  it('returns nothing for unrelated queries', () => {
    expect(rankProjects('internal admin stuff', PROJECTS)).toEqual([])
    expect(rankProjects('xyzzy', PROJECTS)).toEqual([])
  })

  it('a shared single word does not hijack toward the wrong project', () => {
    // "video" appears in Ignite Video Updates but a mostly-unmatched query
    // should not resolve to it.
    expect(rankProjects('random video thing entirely', PROJECTS)).toEqual([])
  })
})

describe('scoreProjectMatch', () => {
  it('weights exact code matches highest', () => {
    const byCode = scoreProjectMatch('2626-MSFT', PROJECTS[1])
    const byName = scoreProjectMatch('magic', PROJECTS[1])
    expect(byCode).toBeGreaterThan(byName)
  })

  it('gives zero for empty or stopword-only queries', () => {
    expect(scoreProjectMatch('', PROJECTS[0])).toBe(0)
    expect(scoreProjectMatch('worked on the project today', PROJECTS[0])).toBe(0)
  })
})
