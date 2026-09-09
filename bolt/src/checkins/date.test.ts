import { describe, expect, it } from 'vitest'
import { formatLongDate, inferSharedDayFromText, resolveDayPhrase } from './date'

describe('casual check-in dates', () => {
  const anchor = '2026-09-09'

  it('resolves a weekday plus ordinal against the current local date', () => {
    expect(resolveDayPhrase('Tuesday the 8th', anchor)).toBe('2026-09-08')
    expect(resolveDayPhrase('on Tuesday 8th', anchor)).toBe('2026-09-08')
  })

  it('resolves conversational month and bare-day forms', () => {
    expect(resolveDayPhrase('Tuesday September 8th', anchor)).toBe('2026-09-08')
    expect(resolveDayPhrase('the 8th', anchor)).toBe('2026-09-08')
  })

  it('uses the nearest prior month when the named day has passed the boundary', () => {
    expect(resolveDayPhrase('the 31st', '2026-09-02')).toBe('2026-08-31')
  })

  it('formats the exact weekday and calendar date for confirmation', () => {
    expect(formatLongDate('2026-09-08')).toBe('Tuesday, September 8, 2026')
  })

  it('finds one shared casual day in the full reply as an LLM fallback', () => {
    expect(
      inferSharedDayFromText(
        'I gave you those hours already — I worked them on Tuesday the 8th.',
        anchor,
      ),
    ).toBe('2026-09-08')
  })

  it('does not apply one shared day when the reply names multiple days', () => {
    expect(
      inferSharedDayFromText('4h on Fabric Tuesday and 3h on Kimmel Wednesday', anchor),
    ).toBeNull()
  })
})
