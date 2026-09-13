import { describe, expect, it } from 'vitest'
import { buildConfirmBlocks, type ParsedEntry } from './reply'

function matched(hours: number, project: string, spentDate: string): ParsedEntry {
  return {
    projectQuery: project,
    hours,
    spentDate,
    resolution: 'matched',
    harvest_project_id: 1,
    harvest_project_name: project,
  }
}

describe('hours confirmation card dates', () => {
  it('labels today with its exact weekday and date before the entries', () => {
    const blocks = buildConfirmBlocks({
      checkinId: 'checkin-1',
      anchorDate: '2026-09-09',
      entries: [matched(4, 'Fabric IQ', '2026-09-09')],
    }) as Array<{ text: { text: string } }>

    expect(blocks[0].text.text).toContain(
      '*Today — Wednesday, September 9, 2026*\n• *4h* — Fabric IQ',
    )
  })

  it('groups backlogged entries under the exact interpreted dates', () => {
    const blocks = buildConfirmBlocks({
      checkinId: 'checkin-1',
      anchorDate: '2026-09-09',
      entries: [
        matched(4, 'Fabric IQ', '2026-09-08'),
        matched(2, 'Kimmel', '2026-09-09'),
      ],
    }) as Array<{ text: { text: string } }>
    const text = blocks[0].text.text

    expect(text).toContain('*Tuesday, September 8, 2026*\n• *4h* — Fabric IQ')
    expect(text).toContain('*Today — Wednesday, September 9, 2026*\n• *2h* — Kimmel')
  })
})
