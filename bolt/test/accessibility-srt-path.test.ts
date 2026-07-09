import { describe, it, expect } from 'vitest'

import { matchAccessibilitySrt } from '../src/watchers/dropbox'

describe('matchAccessibilitySrt', () => {
  it('matches an SRT in "02_Accessibility Files" and returns the safeName', () => {
    expect(
      matchAccessibilitySrt('/production/2026/2626_MSFT_MagicQuadrant/02_Accessibility Files/spot_v2.srt'),
    ).toBe('2626_MSFT_MagicQuadrant')
  })

  it('matches other accessibility folder names, case-insensitively', () => {
    expect(
      matchAccessibilitySrt('/production/2026/proj/Accessibility/cut.srt'),
    ).toBe('proj')
    expect(
      matchAccessibilitySrt('/production/2025/proj/03_accessibility_captions/a.SRT'),
    ).toBe('proj')
  })

  it('matches when the accessibility folder is nested deeper', () => {
    expect(
      matchAccessibilitySrt('/production/2026/proj/09_Outgoing/02_Delivery/Accessibility Files/x.srt'),
    ).toBe('proj')
  })

  it('does not match non-SRT files', () => {
    expect(
      matchAccessibilitySrt('/production/2026/proj/02_Accessibility Files/spot.mov'),
    ).toBeNull()
  })

  it('does not match SRTs outside an accessibility folder', () => {
    expect(matchAccessibilitySrt('/production/2026/proj/05_Edit/spot.srt')).toBeNull()
  })

  it('requires the accessibility folder to be the SRT’s immediate parent', () => {
    // accessibility is a grandparent, .srt sits in a plain subfolder
    expect(
      matchAccessibilitySrt('/production/2026/proj/Accessibility/raw/spot.srt'),
    ).toBeNull()
  })

  it('ignores paths outside /production', () => {
    expect(
      matchAccessibilitySrt('/Delivery-Queue/proj/02_Accessibility Files/spot.srt'),
    ).toBeNull()
  })
})
