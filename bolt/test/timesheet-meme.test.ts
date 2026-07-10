import { describe, it, expect } from 'vitest'

import {
  TEMPLATES,
  pickWeeklyTemplate,
  weekIndexFromMs,
  normalizeBoxes,
} from '../src/memes/timesheet-meme'

describe('pickWeeklyTemplate', () => {
  it('rotates to a different template each consecutive week', () => {
    const a = pickWeeklyTemplate(0)
    const b = pickWeeklyTemplate(1)
    const c = pickWeeklyTemplate(2)
    expect(a.id).not.toBe(b.id)
    expect(b.id).not.toBe(c.id)
  })

  it('wraps around after the last template and is stable per week', () => {
    expect(pickWeeklyTemplate(TEMPLATES.length).id).toBe(pickWeeklyTemplate(0).id)
    expect(pickWeeklyTemplate(5).id).toBe(pickWeeklyTemplate(5).id)
  })

  it('handles negative indices without crashing', () => {
    expect(pickWeeklyTemplate(-1).id).toBe(TEMPLATES[TEMPLATES.length - 1].id)
  })
})

describe('weekIndexFromMs', () => {
  it('increments by one every 7 days and is stable within a week', () => {
    const base = 1_000 * 7 * 24 * 60 * 60 * 1000 // some week boundary
    expect(weekIndexFromMs(base)).toBe(weekIndexFromMs(base + 6 * 24 * 60 * 60 * 1000))
    expect(weekIndexFromMs(base + 7 * 24 * 60 * 60 * 1000)).toBe(weekIndexFromMs(base) + 1)
  })
})

describe('normalizeBoxes', () => {
  it('trims to the box count', () => {
    expect(normalizeBoxes(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
  it('pads to the box count with empty strings', () => {
    expect(normalizeBoxes(['a'], 3)).toEqual(['a', '', ''])
  })
  it('coerces non-arrays / junk to the right length of blanks', () => {
    expect(normalizeBoxes(null, 2)).toEqual(['', ''])
    expect(normalizeBoxes(undefined, 1)).toEqual([''])
  })
})
