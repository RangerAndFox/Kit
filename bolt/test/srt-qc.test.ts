import { describe, it, expect } from 'vitest'

import { buildQcBlocks, type QcReport } from '../src/delivery/srt-qc'

describe('buildQcBlocks', () => {
  it('returns a green-check block when clean', () => {
    const report: QcReport = { checked: true, clean: true, cueCount: 42, issues: [] }
    const blocks = buildQcBlocks(report, 'Spot_v3.srt')
    expect(blocks).not.toBeNull()
    const text = blocks![0].text.text
    expect(text).toContain(':white_check_mark:')
    expect(text).toContain('Spot_v3.srt')
    expect(text).toContain('42 cues')
  })

  it('returns a red-x block listing each issue when not clean', () => {
    const report: QcReport = {
      checked: true,
      clean: false,
      cueCount: 10,
      issues: [
        { cue: 3, category: 'naming', text: 'Github', problem: 'brand capitalization', fix: 'GitHub' },
        { cue: 7, category: 'spelling', text: 'teh', problem: 'misspelling', fix: 'the' },
      ],
    }
    const blocks = buildQcBlocks(report, 'Promo.srt')!
    const header = blocks[0].text.text
    const body = blocks[1].text.text
    expect(header).toContain(':x:')
    expect(header).toContain('2 issues')
    expect(body).toContain('Cue 3')
    expect(body).toContain('GitHub')
    expect(body).toContain('Cue 7')
    expect(body).toContain('the')
  })

  it('uses singular "issue" for a single finding', () => {
    const report: QcReport = {
      checked: true,
      clean: false,
      cueCount: 5,
      issues: [{ cue: 1, category: 'grammar', text: 'they was', problem: 'agreement', fix: 'they were' }],
    }
    const blocks = buildQcBlocks(report, 'x.srt')!
    expect(blocks[0].text.text).toContain('1 issue*')
  })

  it('returns null when QC did not run (unchecked)', () => {
    const report: QcReport = { checked: false, clean: true, cueCount: 0, issues: [] }
    expect(buildQcBlocks(report, 'x.srt')).toBeNull()
  })
})
