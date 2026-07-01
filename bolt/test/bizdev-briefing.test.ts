import { describe, it, expect } from 'vitest'

import {
  hasBizdevAttendee,
  buildStaffEmailSet,
  filterExternalAttendees,
  buildBizdevBriefingText,
} from '../../src/lib/agent/bizdev-briefing'

describe('hasBizdevAttendee', () => {
  const bizdevEmails = new Set(['erin@rangerandfox.tv'])

  it('detects a bizdev staffer on the invite', () => {
    expect(hasBizdevAttendee(['client@acme.com', 'erin@rangerandfox.tv'], bizdevEmails)).toBe(true)
  })

  it('matches case-insensitively and trims whitespace', () => {
    expect(hasBizdevAttendee([' Erin@RangerAndFox.tv '], bizdevEmails)).toBe(true)
  })

  it('returns false when no bizdev staffer is present', () => {
    expect(hasBizdevAttendee(['client@acme.com', 'steve@rangerandfox.tv'], bizdevEmails)).toBe(false)
  })

  it('returns false for an empty attendee list', () => {
    expect(hasBizdevAttendee([], bizdevEmails)).toBe(false)
  })
})

describe('buildStaffEmailSet', () => {
  it('includes primary emails and aliases, lowercased', () => {
    const set = buildStaffEmailSet([
      { email: 'Jared@RangerAndFox.tv', email_aliases: ['JaredDoud@rangerandfox.tv'] },
      { email: 'steve@rangerandfox.tv', email_aliases: null },
    ])
    expect(set.has('jared@rangerandfox.tv')).toBe(true)
    expect(set.has('jareddoud@rangerandfox.tv')).toBe(true)
    expect(set.has('steve@rangerandfox.tv')).toBe(true)
  })

  it('skips staff with no email', () => {
    const set = buildStaffEmailSet([{ email: null, email_aliases: [] }])
    expect(set.size).toBe(0)
  })
})

describe('filterExternalAttendees', () => {
  const internal = new Set(['steve@rangerandfox.tv'])

  it('keeps only attendees not in the internal set', () => {
    const out = filterExternalAttendees(
      [{ email: 'client@acme.com' }, { email: 'steve@rangerandfox.tv' }],
      internal,
    )
    expect(out).toEqual([{ email: 'client@acme.com' }])
  })

  it('matches internal emails case-insensitively', () => {
    const out = filterExternalAttendees([{ email: 'Steve@RangerAndFox.tv' }], internal)
    expect(out).toEqual([])
  })

  it('drops attendees with no email', () => {
    const out = filterExternalAttendees([{ email: '' }], internal)
    expect(out).toEqual([])
  })
})

describe('buildBizdevBriefingText', () => {
  const event: any = {
    summary: 'Intro call — Acme Corp',
    start_time: '2026-07-01T18:00:00Z',
  }

  it('renders a bio per external attendee', () => {
    const text = buildBizdevBriefingText({
      event,
      externals: [{ email: 'jane@acme.com', displayName: 'Jane Doe' }],
      bios: ['Jane is the VP of Marketing at Acme.'],
    })
    expect(text).toContain('business development')
    expect(text).toContain('Intro call — Acme Corp')
    expect(text).toContain('Jane Doe')
    expect(text).toContain('jane@acme.com')
    expect(text).toContain('Jane is the VP of Marketing at Acme.')
  })

  it('falls back to a placeholder when a bio lookup failed', () => {
    const text = buildBizdevBriefingText({
      event,
      externals: [{ email: 'jane@acme.com' }],
      bios: [null],
    })
    expect(text).toContain('No reliable info found')
  })

  it('notes when there are no external attendees', () => {
    const text = buildBizdevBriefingText({ event, externals: [], bios: [] })
    expect(text).toContain('No external attendees found')
  })
})
