import { describe, it, expect } from 'vitest'

import { intersectProjectChannels } from '../src/checkins/slack-activity'
import { mergeCandidates } from '../src/checkins/daily-hours'
import { buildFlagText } from '../src/checkins/missing-time'

describe('intersectProjectChannels', () => {
  const projectChannels = [
    { channelId: 'C1', projectId: 'p1', projectName: '2620 Microsoft Sizzle' },
    { channelId: 'C2', projectId: 'p2', projectName: '2631 Acme Promo' },
    { channelId: 'C3', projectId: 'p3', projectName: '2599 Old Project' },
  ]

  it('returns only project channels the user belongs to, with channel names', () => {
    const member = [
      { id: 'C1', name: '2620-microsoft-sizzle' },
      { id: 'C9', name: 'random' },
      { id: 'C2', name: '2631-acme-promo' },
    ]
    const active = intersectProjectChannels(projectChannels, member)
    expect(active.map((a) => a.projectId)).toEqual(['p1', 'p2'])
    expect(active[0].channelName).toBe('2620-microsoft-sizzle')
  })

  it('returns [] when the user is in none of the project channels', () => {
    expect(intersectProjectChannels(projectChannels, [{ id: 'Cx' }])).toEqual([])
  })
})

describe('mergeCandidates', () => {
  const harvest = [
    { harvest_project_id: 10, harvest_project_name: 'Acme Promo', signal_hours_last_7d: 6, reasons: ['Harvest (last 7d)'] },
  ]
  const active = [
    { projectId: 'p2', projectName: 'Acme Promo', channelId: 'C2', channelName: 'acme-promo' }, // dupe
    { projectId: 'p1', projectName: 'Microsoft Sizzle', channelId: 'C1', channelName: 'ms-sizzle' },
  ]

  it('keeps Harvest candidates first and appends non-duplicate inferred ones', () => {
    const merged = mergeCandidates(harvest, active)
    expect(merged.map((c) => c.harvest_project_name)).toEqual(['Acme Promo', 'Microsoft Sizzle'])
    // Inferred candidate carries the channel + zero hours.
    const inferred = merged[1]
    expect(inferred.signal_hours_last_7d).toBe(0)
    expect(inferred.slack_channel_name).toBe('ms-sizzle')
    expect(inferred.reasons[0]).toMatch(/Active in #ms-sizzle/)
  })

  it('dedupes case-insensitively by project name', () => {
    const merged = mergeCandidates(
      [{ harvest_project_name: 'acme promo', signal_hours_last_7d: 2, reasons: [] }],
      [{ projectId: 'p2', projectName: 'Acme Promo', channelId: 'C2', channelName: 'acme' }],
    )
    expect(merged).toHaveLength(1)
  })

  it('caps the merged list at max', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      projectId: `p${i}`,
      projectName: `Proj ${i}`,
      channelId: `C${i}`,
      channelName: `c${i}`,
    }))
    expect(mergeCandidates([], many, 6)).toHaveLength(6)
  })
})

describe('buildFlagText with active channels', () => {
  it('names the channels the artist has been active in', () => {
    const text = buildFlagText({
      slackUserId: 'U1',
      fullName: 'Alice',
      missing: ['2026-06-25', '2026-06-24', '2026-06-23'],
      lastLogged: null,
      activeChannels: [
        { projectId: 'p1', projectName: 'MS', channelId: 'C1', channelName: 'ms' },
        { projectId: 'p2', projectName: 'Acme', channelId: 'C2', channelName: 'acme' },
      ],
    })
    expect(text).toContain('Active lately in:')
    expect(text).toContain('<#C1>')
    expect(text).toContain('<#C2>')
  })

  it('omits the active-in line when there are no channels', () => {
    const text = buildFlagText({
      slackUserId: 'U1',
      fullName: 'Alice',
      missing: ['2026-06-25'],
      lastLogged: null,
      activeChannels: [],
    })
    expect(text).not.toContain('Active lately in')
  })
})
