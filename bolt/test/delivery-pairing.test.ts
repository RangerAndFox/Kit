import { describe, it, expect } from 'vitest'

import { pairSpecsFiles, fileStem, fileExt, type SpecsFile } from '../../src/lib/delivery/pairing'

function vid(name: string): SpecsFile {
  return { path: `/p/specs/video/${name}`, name, kind: 'video', size_bytes: 1000 }
}
function aud(name: string): SpecsFile {
  return { path: `/p/specs/audio/${name}`, name, kind: 'audio', size_bytes: 100 }
}

describe('fileStem / fileExt', () => {
  it('normalizes separators and case for matching', () => {
    expect(fileStem('Spot_V3 final.mov')).toBe(fileStem('spot-v3-final.wav'))
    expect(fileStem('A B.mov')).toBe('ab')
  })
  it('reads the extension', () => {
    expect(fileExt('clip.MOV')).toBe('mov')
    expect(fileExt('noext')).toBe('')
  })
})

describe('pairSpecsFiles — video anchor', () => {
  it('pairs a video with its stem-matched audio', () => {
    const r = pairSpecsFiles({
      trigger: vid('spotV3.mov'),
      videoFiles: [vid('spotV3.mov')],
      audioFiles: [aud('spotV3.wav')],
    })
    expect(r.video?.name).toBe('spotV3.mov')
    expect(r.audio?.name).toBe('spotV3.wav')
    expect(r.ok).toBe(true)
    expect(r.needsChoice).toBe(false)
    expect(r.warnings).toEqual([])
  })

  it('matches across separator/case differences', () => {
    const r = pairSpecsFiles({
      trigger: vid('Spot_V3 Final.mov'),
      videoFiles: [vid('Spot_V3 Final.mov')],
      audioFiles: [aud('spot-v3-final.wav')],
    })
    expect(r.audio?.name).toBe('spot-v3-final.wav')
    expect(r.ok).toBe(true)
  })

  it('renders with embedded audio when specs/audio is empty (warns)', () => {
    const r = pairSpecsFiles({ trigger: vid('a.mov'), videoFiles: [vid('a.mov')], audioFiles: [] })
    expect(r.audio).toBeNull()
    expect(r.ok).toBe(true)
    expect(r.needsChoice).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/embedded audio/i)
  })

  it('flags when audio exists but none matches the video by name', () => {
    const r = pairSpecsFiles({
      trigger: vid('spotV3.mov'),
      videoFiles: [vid('spotV3.mov')],
      audioFiles: [aud('otherMix.wav')],
    })
    expect(r.audio).toBeNull()
    expect(r.ok).toBe(true)
    expect(r.needsChoice).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/No audio matched/i)
  })

  it('flags ambiguity when multiple audio files match', () => {
    const r = pairSpecsFiles({
      trigger: vid('spot.mov'),
      videoFiles: [vid('spot.mov')],
      audioFiles: [aud('spot.wav'), aud('Spot.aif')],
    })
    expect(r.needsChoice).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/matches 2 audio/i)
  })
})

describe('pairSpecsFiles — audio anchor', () => {
  it('pairs a dropped audio back to its matching video', () => {
    const r = pairSpecsFiles({
      trigger: aud('spotV3.wav'),
      videoFiles: [vid('spotV3.mov')],
      audioFiles: [aud('spotV3.wav')],
    })
    expect(r.video?.name).toBe('spotV3.mov')
    expect(r.audio?.name).toBe('spotV3.wav')
    expect(r.ok).toBe(true)
  })

  it('parks when an audio drop has no matching video yet', () => {
    const r = pairSpecsFiles({
      trigger: aud('spotV3.wav'),
      videoFiles: [],
      audioFiles: [aud('spotV3.wav')],
    })
    expect(r.video).toBeNull()
    expect(r.ok).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/no matching video/i)
  })
})

describe('pairSpecsFiles — misfiled detection', () => {
  it('flags a video sitting in the audio folder', () => {
    const r = pairSpecsFiles({
      trigger: vid('spot.mov'),
      videoFiles: [vid('spot.mov')],
      audioFiles: [{ path: '/p/specs/audio/take.mov', name: 'take.mov', kind: 'audio', size_bytes: 9 }],
    })
    expect(r.warnings.join(' ')).toMatch(/wrong folder/i)
  })
})
