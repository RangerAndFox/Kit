import { describe, it, expect } from 'vitest'
import { isDeniedUploadFile } from '../src/watchers/dropbox'

describe('isDeniedUploadFile — Frame.io upload denylist', () => {
  it('denies .aac and .m4v', () => {
    expect(isDeniedUploadFile('mixdown.aac')).toBe(true)
    expect(isDeniedUploadFile('proxy.m4v')).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isDeniedUploadFile('MIXDOWN.AAC')).toBe(true)
    expect(isDeniedUploadFile('Proxy.M4v')).toBe(true)
  })

  it('checks the basename, not intermediate folders', () => {
    expect(isDeniedUploadFile('051326/v1/mix.aac')).toBe(true)
    expect(isDeniedUploadFile('051326/v1/hero.mov')).toBe(false)
    // A folder named like a denied ext must not trip it — the file does.
    expect(isDeniedUploadFile('audio.aac/hero.mov')).toBe(false)
  })

  it('allows normal deliverable types', () => {
    for (const name of ['hero.mov', 'cut.mp4', 'mix.wav', 'brief.pdf', 'still.png']) {
      expect(isDeniedUploadFile(name)).toBe(false)
    }
  })

  it('does not deny files whose name merely contains the token', () => {
    expect(isDeniedUploadFile('aac_master.mov')).toBe(false)
    expect(isDeniedUploadFile('m4v-reference.mp4')).toBe(false)
  })

  it('never denies extensionless files or dotfiles', () => {
    expect(isDeniedUploadFile('README')).toBe(false)
    expect(isDeniedUploadFile('.gitkeep')).toBe(false)
  })
})
