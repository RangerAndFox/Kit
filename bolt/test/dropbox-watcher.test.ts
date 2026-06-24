import { describe, it, expect } from 'vitest'
import { isDeniedDeliveryFile } from '../src/watchers/dropbox'

describe('isDeniedDeliveryFile', () => {
  it('denies the default .aac and .m4v extensions', () => {
    expect(isDeniedDeliveryFile('mix.aac')).toBe(true)
    expect(isDeniedDeliveryFile('hero-cut.m4v')).toBe(true)
  })

  it('allows real video deliverables', () => {
    expect(isDeniedDeliveryFile('hero-cut-v3.mov')).toBe(false)
    expect(isDeniedDeliveryFile('promo.mp4')).toBe(false)
    expect(isDeniedDeliveryFile('master.mxf')).toBe(false)
  })

  it('is case-insensitive and only looks at the final path segment', () => {
    expect(isDeniedDeliveryFile('051326/v1/MIX.AAC')).toBe(true)
    expect(isDeniedDeliveryFile('051326/v1/asset.mov')).toBe(false)
    // A subfolder named like an extension must not trip the check.
    expect(isDeniedDeliveryFile('mix.aac/asset.mov')).toBe(false)
  })

  it('handles dotless names and dotfiles safely', () => {
    expect(isDeniedDeliveryFile('READme')).toBe(false)
    expect(isDeniedDeliveryFile('.aac')).toBe(false) // leading-dot only, no basename
  })

  it('honors a custom deny set', () => {
    const deny = new Set(['wav', 'mp3'])
    expect(isDeniedDeliveryFile('stem.wav', deny)).toBe(true)
    expect(isDeniedDeliveryFile('mix.aac', deny)).toBe(false)
  })
})
