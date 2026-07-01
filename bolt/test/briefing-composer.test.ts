import { describe, it, expect } from 'vitest'

import { buildBriefingText, matchAttendeesToStaff } from '../../src/lib/agent/briefing-composer'

const event: any = {
  summary: 'Rayfin client review',
  start_time: '2026-06-25T17:00:00Z',
  attendees: [{ email: 'client@acme.com' }, { email: 'jared@rangerandfox.tv' }],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
}

describe('buildBriefingText', () => {
  it('renders project header, attendees, actions, and the project recap', () => {
    const text = buildBriefingText({
      event,
      project: { name: 'Rayfin', client: 'Acme', project_code: '2620', brief_summary: 'Sizzle reel', external_links: {} },
      actions: [{ title: 'Send v2 for approval' }],
      lastTranscript: { start_time: '2026-06-20T17:00:00Z', transcript: 'We discussed the edit timeline.' },
    })
    expect(text).toContain('Rayfin client review')
    expect(text).toContain('*Project:* Rayfin (Acme) — 2620')
    expect(text).toContain('Send v2 for approval')
    expect(text).toContain('Last meeting')
    expect(text).toContain('We discussed the edit timeline.')
    expect(text).toContain('client@acme.com')
  })

  it('accepts both the *_url and bare external_links keys', () => {
    const urlKeys = buildBriefingText({
      event,
      project: { name: 'P', external_links: { frameio_url: 'https://f.io/x', dropbox_url: 'https://db/x' } },
      actions: null,
      lastTranscript: null,
    })
    expect(urlKeys).toContain('Frame.io: https://f.io/x')
    expect(urlKeys).toContain('Dropbox: https://db/x')

    const bareKeys = buildBriefingText({
      event,
      project: { name: 'P', external_links: { frameio: 'https://f.io/y', dropbox: 'https://db/y' } },
      actions: null,
      lastTranscript: null,
    })
    expect(bareKeys).toContain('Frame.io: https://f.io/y')
    expect(bareKeys).toContain('Dropbox: https://db/y')
    // Google Meet link always comes from the event.
    expect(bareKeys).toContain('meet.google.com')
  })

  it('truncates a long recap to 400 chars with an ellipsis', () => {
    const long = 'x'.repeat(600)
    const text = buildBriefingText({
      event,
      project: { name: 'P', external_links: {} },
      actions: null,
      lastTranscript: { start_time: '2026-06-20T17:00:00Z', transcript: long },
    })
    expect(text).toContain('x'.repeat(400) + '…')
    expect(text).not.toContain('x'.repeat(401))
  })

  it('omits sections that have no data', () => {
    const text = buildBriefingText({
      event: { ...event, attendees: [], hangoutLink: undefined },
      project: null,
      actions: null,
      lastTranscript: null,
    })
    expect(text).not.toContain('*Project:*')
    expect(text).not.toContain('*Links:*')
    expect(text).not.toContain('*Attendees:*')
    expect(text).not.toContain('*Last meeting')
  })
})

describe('matchAttendeesToStaff (privacy)', () => {
  const staff = [
    { email: 'jared@rangerandfox.tv', slack_user_id: 'U_JARED', full_name: 'Jared', is_active: true },
    { email: 'Steve@RangerAndFox.tv', slack_user_id: 'U_STEVE', full_name: 'Steve', is_active: true },
    { email: 'former@rangerandfox.tv', slack_user_id: 'U_OLD', full_name: 'Former', is_active: false },
    { email: 'nobot@rangerandfox.tv', slack_user_id: null, full_name: 'No Slack', is_active: true },
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
