import { describe, it, expect } from 'vitest'
import {
  parseBirthday,
  birthdayIsToday,
  monthDay,
  parseCelebrateArgs,
  nextOccurrence,
} from '../src/celebrations/celebrations'

describe('parseBirthday', () => {
  it('normalizes MM-DD / M/D forms', () => {
    expect(parseBirthday('3-14')).toBe('03-14')
    expect(parseBirthday('03/14')).toBe('03-14')
    expect(parseBirthday('12-9')).toBe('12-09')
  })
  it('rejects nonsense', () => {
    expect(parseBirthday('13-01')).toBeNull()
    expect(parseBirthday('3')).toBeNull()
    expect(parseBirthday('March 14')).toBeNull()
  })
})

describe('monthDay + birthdayIsToday', () => {
  it('extracts MM-DD from an ISO date', () => {
    expect(monthDay('2026-03-14')).toBe('03-14')
  })
  it('matches only on the right day', () => {
    expect(birthdayIsToday('03-14', '03-14')).toBe(true)
    expect(birthdayIsToday('3-14', '03-14')).toBe(true)
    expect(birthdayIsToday('03-15', '03-14')).toBe(false)
    expect(birthdayIsToday(null, '03-14')).toBe(false)
  })
})

describe('parseCelebrateArgs', () => {
  it('treats a leading date as a scheduled occasion', () => {
    const r = parseCelebrateArgs('12-20 Studio anniversary', '2026-07-13')
    expect(r.fireDate).toBe('2026-12-20')
    expect(r.label).toBe('Studio anniversary')
  })
  it('rolls a past date to next year', () => {
    const r = parseCelebrateArgs('01-05 New year kickoff', '2026-07-13')
    expect(r.fireDate).toBe('2027-01-05')
  })
  it('treats plain text as an ad-hoc now post', () => {
    const r = parseCelebrateArgs('we landed the Nike pitch', '2026-07-13')
    expect(r.fireDate).toBeNull()
    expect(r.label).toBe('we landed the Nike pitch')
  })
})

describe('nextOccurrence', () => {
  it('uses this year when the date is still ahead', () => {
    expect(nextOccurrence(12, 25, '2026-07-13')).toBe('2026-12-25')
  })
  it('uses today itself when it matches', () => {
    expect(nextOccurrence(7, 13, '2026-07-13')).toBe('2026-07-13')
  })
})
