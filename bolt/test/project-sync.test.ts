import { describe, it, expect } from 'vitest'

import { projectNumberKey, planProjectSync } from '../../src/lib/studio-knowledge/project-sync'

describe('projectNumberKey', () => {
  it('extracts the number from various code/name shapes', () => {
    expect(projectNumberKey('2629-Microsoft')).toBe('2629')
    expect(projectNumberKey('2611-MSFT')).toBe('2611')
    expect(projectNumberKey('2545')).toBe('2545')
    expect(projectNumberKey('2540a')).toBe('2540a')
    expect(projectNumberKey('2612A-Unknown')).toBe('2612a')
    expect(projectNumberKey('2502B')).toBe('2502b')
    expect(projectNumberKey('2630A_Internal_Marshmallow_Man')).toBe('2630a')
    expect(projectNumberKey('2611 | Microsoft | AI in Meetings (Meera)')).toBe('2611')
  })

  it('returns null when there is no project number', () => {
    expect(projectNumberKey(null)).toBeNull()
    expect(projectNumberKey('')).toBeNull()
    expect(projectNumberKey('Marshmallow Man')).toBeNull()
  })

  it('keeps a letter suffix distinct (2540a ≠ 2540b)', () => {
    expect(projectNumberKey('2540a')).not.toBe(projectNumberKey('2540b'))
  })
})

describe('planProjectSync', () => {
  const existing = [
    { id: 'u1', project_code: '2629-Microsoft', name: 'Marketing Research Agent', harvest_project_id: null },
    { id: 'u2', project_code: '2540a', name: 'VivaEngage', harvest_project_id: null },
    { id: 'u3', project_code: '2540b', name: 'VivaEngage', harvest_project_id: null },
    { id: 'u4', project_code: '2611-MSFT', name: 'AI in Meetings', harvest_project_id: 555 },
  ]

  it('inserts a Harvest project whose number is missing from Supabase', () => {
    const plan = planProjectSync(
      [{ id: 900, name: '2630A_Internal_Marshmallow_Man', code: '2630A', is_active: true, client: { id: 1, name: 'Internal' } }],
      existing,
    )
    expect(plan.toInsert).toHaveLength(1)
    expect(plan.toInsert[0]).toMatchObject({ harvestId: 900, code: '2630A', status: 'active' })
    expect(plan.toLink).toHaveLength(0)
  })

  it('links an existing unlinked row by number (backfills harvest_project_id, no clobber)', () => {
    const plan = planProjectSync(
      [{ id: 100, name: '2629 | Microsoft | Marketing Research Agent', code: '2629', is_active: true }],
      existing,
    )
    expect(plan.toInsert).toHaveLength(0)
    expect(plan.toLink).toEqual([{ supabaseId: 'u1', harvestId: 100, name: 'Marketing Research Agent', code: '2629-Microsoft' }])
  })

  it('counts an already-linked row (same Harvest id) as a no-op', () => {
    const plan = planProjectSync(
      [{ id: 555, name: 'AI in Meetings', code: '2611', is_active: true }],
      existing,
    )
    expect(plan.alreadyLinked).toBe(1)
    expect(plan.toLink).toHaveLength(0)
    expect(plan.toInsert).toHaveLength(0)
  })

  it('flags a conflict when the matched row is linked to a DIFFERENT Harvest id', () => {
    const plan = planProjectSync(
      [{ id: 999, name: 'AI in Meetings', code: '2611', is_active: true }],
      existing,
    )
    expect(plan.ambiguous).toHaveLength(1)
    expect(plan.toLink).toHaveLength(0)
  })

  it('never guesses between duplicate numbers — reports ambiguous instead', () => {
    // Two Supabase rows share number 2540 (a/b) — a Harvest "2540" can't be
    // safely assigned to either.
    const dupExisting = [
      { id: 'd1', project_code: '2540', name: 'VivaEngage One', harvest_project_id: null },
      { id: 'd2', project_code: '2540', name: 'VivaEngage Two', harvest_project_id: null },
    ]
    const plan = planProjectSync(
      [{ id: 700, name: 'VivaEngage', code: '2540', is_active: true }],
      dupExisting,
    )
    expect(plan.ambiguous).toHaveLength(1)
    expect(plan.toInsert).toHaveLength(0)
    expect(plan.toLink).toHaveLength(0)
  })

  it('2540a and 2540b are treated as distinct projects', () => {
    const plan = planProjectSync(
      [
        { id: 810, name: 'VivaEngage A', code: '2540a', is_active: false },
        { id: 811, name: 'VivaEngage B', code: '2540b', is_active: false },
      ],
      existing,
    )
    // Both match their own row (u2, u3) → two links, no inserts, no ambiguity.
    expect(plan.toLink.map((l) => l.supabaseId).sort()).toEqual(['u2', 'u3'])
    expect(plan.toInsert).toHaveLength(0)
    expect(plan.ambiguous).toHaveLength(0)
  })

  it('reports a Harvest project with no parseable number instead of inserting junk', () => {
    const plan = planProjectSync(
      [{ id: 1, name: 'Misc internal stuff', code: '', is_active: true }],
      existing,
    )
    expect(plan.toInsert).toHaveLength(0)
    expect(plan.ambiguous).toHaveLength(1)
  })
})
