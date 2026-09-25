import { expect, it } from 'vitest'
import { checkinIntentKey } from './intent'
const base = { checkinId: 'one', origin: 'adhoc', staffId: 's1', harvestUserId: 1, project: 2, task: 3, date: '2026-09-25', hours: 4, notes: '' }

it('ad-hoc intent is independent of the confirmation row, including whitespace-only notes', () => {
  expect(checkinIntentKey(base)).toBe(checkinIntentKey({ ...base, checkinId: 'two', notes: '  ' }))
})
it('distinct people, dates, projects and intentional separate work notes remain distinct', () => {
  for (const change of [{ staffId: 's2' }, { harvestUserId: 9 }, { project: 9 }, { date: '2026-09-24' }, { notes: 'additional afternoon session' }]) {
    expect(checkinIntentKey({ ...base, ...change })).not.toBe(checkinIntentKey(base))
  }
})
it('scheduled check-ins preserve the existing row-scoped marker', () => {
  expect(checkinIntentKey({ ...base, origin: 'scheduled' })).toMatch(/^one:[a-f0-9]{16}$/)
  expect(checkinIntentKey({ ...base, origin: 'scheduled' })).not.toBe(checkinIntentKey({ ...base, checkinId: 'two', origin: 'scheduled' }))
})
