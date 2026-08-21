import { describe, it, expect } from 'vitest'

import { buildBriefingText, matchAttendeesToStaff } from '../../src/lib/agent/briefing-composer'

const event: any = {
  summary: 'Rayfin client review',
  start_time: '2026-06-25T17:00:00Z',
  end_time: '2026-06-25T18:00:00Z',
  attendees: [{ email: 'client@acme.com' }, { email: 'jared@rangerandfox.tv' }],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
}

describe('buildBriefingText', () => {
  const janeEvidence: any = {
    identity: { status: 'resolved', name: 'Jane Doe', company: 'Acme', candidates: [] },
    facts: [
      { claim: 'VP of Marketing at Acme', source_ref: 'https://linkedin.com/in/jane-doe' },
      { claim: 'Leads Acme brand storytelling', source_ref: 'https://acme.com/team' },
      { claim: 'May control the entire budget', source_ref: null },
      { claim: 'Prior R&F meeting: Acme discovery', source_ref: 'internal:meeting_briefings' },
    ],
    inferences: [], missing: [], sources: [],
  }

  it('renders the concise three-section layout for an active-project meeting', () => {
    const text = buildBriefingText({
      event,
      project: { name: 'Rayfin', client: 'Acme', project_code: '2620', brief_summary: 'Sizzle reel' },
      externals: [{ email: 'client@acme.com', displayName: 'Jane Doe' }],
      evidence: [janeEvidence],
      positioning: 'Ranger & Fox can keep the creative and approval process moving toward delivery.',
    })
    expect(text).toContain('*Meeting info*')
    expect(text).toContain('*Subject:* Rayfin client review')
    expect(text).toMatch(/\*Date & time:\* .+–.+/)
    expect(text).toContain('*Project:* 2620 | Rayfin — Acme')
    expect(text).toContain('*Attendee info*')
    expect(text).toContain('*Jane Doe:* VP of Marketing at Acme.')
    expect(text).toContain('Leads Acme brand storytelling.')
    expect(text).not.toContain('May control the entire budget')
    expect(text).not.toContain('Prior R&F meeting')
    expect(text).toContain('*Positioning*')
    expect(text).toContain('approval process')
  })

  it('uses the same simplified layout for a project kickoff', () => {
    const text = buildBriefingText({
      event: { ...event, summary: 'Rayfin project kickoff' },
      project: { name: 'Rayfin', client: 'Acme', project_code: '2620' },
      externals: [{ email: 'client@acme.com', displayName: 'Jane Doe' }],
      evidence: [janeEvidence],
      positioning: 'Use this kickoff to align the audience, milestones, ownership, and feedback process.',
    })
    expect(text).toContain('*Meeting info*')
    expect(text).toContain('*Attendee info*')
    expect(text).toContain('*Positioning*')
    expect(text).not.toContain('*Suggested prep:*')
    expect(text).not.toContain('*Open actions:*')
    expect(text).not.toContain('*Last meeting')
  })

  it('lists only external attendees and keeps the meeting link with meeting info', () => {
    const text = buildBriefingText({
      event,
      project: { name: 'Rayfin', client: 'Acme' },
      externals: [{ email: 'client@acme.com', displayName: 'Jane Doe' }],
      evidence: [janeEvidence],
      positioning: 'Ranger & Fox can help Acme turn decisions into an executable production plan.',
    })
    expect(text).toContain('*Jane Doe:*')
    expect(text).not.toContain('jared@rangerandfox.tv')
    expect(text).toContain('*Join:* https://meet.google.com/abc-defg-hij')
    expect(text).not.toContain('*Links:*')
  })

  it('keeps all three sections when no external attendee can be researched', () => {
    const text = buildBriefingText({
      event: { ...event, attendees: [] },
      project: { name: 'Rayfin' },
      externals: [],
      evidence: [],
      positioning: 'Ranger & Fox can use this internal meeting to align the next production milestone.',
    })
    expect(text).toContain('_No external attendees on this invite._')
    expect(text).toContain('*Positioning*')
  })
})

describe('matchAttendeesToStaff (privacy)', () => {
  const staff = [
    { id: 's-jared', email: 'jared@rangerandfox.tv', slack_user_id: 'U_JARED', full_name: 'Jared', is_active: true },
    { id: 's-steve', email: 'Steve@RangerAndFox.tv', slack_user_id: 'U_STEVE', full_name: 'Steve', is_active: true },
    { id: 's-former', email: 'former@rangerandfox.tv', slack_user_id: 'U_OLD', full_name: 'Former', is_active: false },
    { id: 's-nobot', email: 'nobot@rangerandfox.tv', slack_user_id: null, full_name: 'No Slack', is_active: true },
  ]

  it('returns only the R&F attendees actually on the invite', () => {
    const r = matchAttendeesToStaff(
      [{ email: 'jared@rangerandfox.tv' }, { email: 'client@acme.com' }],
      staff,
    )
    expect(r.map((x) => x.slack_user_id)).toEqual(['U_JARED'])
  })

  it('excludes external attendees (clients) entirely', () => {
    const r = matchAttendeesToStaff([{ email: 'client@acme.com' }, { email: 'vendor@x.com' }], staff)
    expect(r).toEqual([])
  })

  it('matches case-insensitively', () => {
    const r = matchAttendeesToStaff([{ email: 'steve@rangerandfox.tv' }], staff)
    expect(r.map((x) => x.slack_user_id)).toEqual(['U_STEVE'])
  })

  it('excludes inactive staff and staff with no Slack id', () => {
    const r = matchAttendeesToStaff(
      [{ email: 'former@rangerandfox.tv' }, { email: 'nobot@rangerandfox.tv' }],
      staff,
    )
    expect(r).toEqual([])
  })

  it('dedupes a staffer listed twice', () => {
    const r = matchAttendeesToStaff(
      [{ email: 'jared@rangerandfox.tv' }, { email: 'jared@rangerandfox.tv' }],
      staff,
    )
    expect(r).toHaveLength(1)
  })

  it('matches an invite that uses an email alias (Slack email differs from calendar email)', () => {
    const aliased = [
      {
        id: 's-jared',
        email: 'jared@rangerandfox.tv',
        email_aliases: ['jareddoud@rangerandfox.tv'],
        slack_user_id: 'U_JARED',
        full_name: 'Jared Doud',
        is_active: true,
      },
    ]
    // The invite carries the calendar address, not the Slack address.
    const r = matchAttendeesToStaff([{ email: 'jareddoud@rangerandfox.tv' }], aliased)
    expect(r.map((x) => x.slack_user_id)).toEqual(['U_JARED'])
  })

  it('matches an alias case-insensitively and still dedupes vs the primary', () => {
    const aliased = [
      {
        id: 's-jared',
        email: 'jared@rangerandfox.tv',
        email_aliases: ['jareddoud@rangerandfox.tv'],
        slack_user_id: 'U_JARED',
        full_name: 'Jared Doud',
        is_active: true,
      },
    ]
    const r = matchAttendeesToStaff(
      [{ email: 'JaredDoud@RangerAndFox.tv' }, { email: 'jared@rangerandfox.tv' }],
      aliased,
    )
    expect(r).toHaveLength(1)
    expect(r[0].slack_user_id).toBe('U_JARED')
  })
})
