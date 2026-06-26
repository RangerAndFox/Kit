import { describe, it, expect } from 'vitest'

import {
  parseSpecsPath,
  buildSpecsPromptBlocks,
  PICK_SPEC_ACTION,
} from '../../src/lib/delivery/specs-watcher'
import { pairSpecsFiles, type SpecsFile } from '../../src/lib/delivery/pairing'

describe('parseSpecsPath', () => {
  it('parses a specs/video path into project + kind + name', () => {
    const p = parseSpecsPath({
      path_display: '/production/2026/2620_Microsoft_Sizzle/specs/video/spotV3.mov',
      name: 'spotV3.mov',
      size: 123,
      id: 'id:1',
    })
    expect(p).toMatchObject({
      year: '2026',
      safeName: '2620_Microsoft_Sizzle',
      kind: 'video',
      name: 'spotV3.mov',
      size_bytes: 123,
    })
  })

  it('parses specs/audio', () => {
    expect(
      parseSpecsPath({ path_display: '/production/2026/P/specs/audio/m.wav', name: 'm.wav', size: 1, id: 'i' })?.kind,
    ).toBe('audio')
  })

  it('returns null for non-specs paths', () => {
    expect(
      parseSpecsPath({ path_display: '/production/2026/P/09_Outgoing/02_Delivery/x.mov', name: 'x.mov', size: 1, id: 'i' }),
    ).toBeNull()
  })

  it('ignores partial/scratch files', () => {
    expect(
      parseSpecsPath({ path_display: '/production/2026/P/specs/video/x.mov.part', name: 'x.mov.part', size: 1, id: 'i' }),
    ).toBeNull()
  })
})

describe('buildSpecsPromptBlocks', () => {
  const vid: SpecsFile = { path: '/production/2026/P/specs/video/a.mov', name: 'a.mov', kind: 'video', size_bytes: 10 }
  const aud: SpecsFile = { path: '/production/2026/P/specs/audio/a.wav', name: 'a.wav', kind: 'audio', size_bytes: 5 }

  it('renders the pair and a pick-spec button carrying both sources', () => {
    const pair = pairSpecsFiles({ trigger: vid, videoFiles: [vid], audioFiles: [aud] })
    const blocks = buildSpecsPromptBlocks({ projectName: 'Microsoft Sizzle', pair })
    const text = blocks[0].text.text
    expect(text).toContain('Microsoft Sizzle')
    expect(text).toContain('a.mov')
    expect(text).toContain('a.wav')

    const btn = blocks.find((b: any) => b.type === 'actions')!.elements[0]
    expect(btn.action_id).toBe(PICK_SPEC_ACTION)
    const carried = JSON.parse(btn.value).sources
    expect(carried).toHaveLength(2)
    expect(carried.map((s: any) => s.type)).toEqual(['video', 'audio'])
  })

  it('surfaces warnings and still offers the button when video-only', () => {
    const pair = pairSpecsFiles({ trigger: vid, videoFiles: [vid], audioFiles: [] })
    const blocks = buildSpecsPromptBlocks({ projectName: 'P', pair })
    expect(blocks[0].text.text).toMatch(/embedded audio/i)
    const btn = blocks.find((b: any) => b.type === 'actions')!.elements[0]
    expect(JSON.parse(btn.value).sources).toHaveLength(1)
  })

  it('omits the button when there is no usable video (parked audio)', () => {
    const pair = pairSpecsFiles({ trigger: aud, videoFiles: [], audioFiles: [aud] })
    const blocks = buildSpecsPromptBlocks({ projectName: 'P', pair })
    expect(blocks.find((b: any) => b.type === 'actions')).toBeUndefined()
  })
})
