/**
 * Run: npx tsx --test bolt/src/delivery/frameio-toggle.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrameioToggleIntent } from './frameio-toggle'

describe('parseFrameioToggleIntent', () => {
  it('"turn off Frame.io upload" → disable', () => {
    assert.equal(parseFrameioToggleIntent('turn off Frame.io upload')?.action, 'disable')
  })

  it('"disable frame upload" → disable', () => {
    assert.equal(parseFrameioToggleIntent('disable frame upload')?.action, 'disable')
  })

  it('"no frame for this project" → disable', () => {
    assert.equal(parseFrameioToggleIntent('no frame for this project')?.action, 'disable')
  })

  it('"skip frame.io" → disable', () => {
    assert.equal(parseFrameioToggleIntent('skip frame.io')?.action, 'disable')
  })

  it('"turn on Frame.io upload" → enable', () => {
    assert.equal(parseFrameioToggleIntent('turn on Frame.io upload')?.action, 'enable')
  })

  it('"re-enable frame for this project" → enable', () => {
    assert.equal(parseFrameioToggleIntent('re-enable frame for this project')?.action, 'enable')
  })

  it('"is frame upload on?" → status', () => {
    assert.equal(parseFrameioToggleIntent('is frame upload on?')?.action, 'status')
  })

  it('"frame.io status" → status', () => {
    assert.equal(parseFrameioToggleIntent('frame.io status')?.action, 'status')
  })

  it('parses a channel reference (DM usage)', () => {
    const r = parseFrameioToggleIntent('turn off frame upload for <#C12345|client-proj>')
    assert.equal(r?.action, 'disable')
    assert.equal(r?.projectRef?.channelId, 'C12345')
  })

  it('parses a project number (DM usage)', () => {
    const r = parseFrameioToggleIntent('disable frame.io upload for project 2654')
    assert.equal(r?.action, 'disable')
    assert.equal(r?.projectRef?.number, '2654')
  })

  it('parses a suffixed project number', () => {
    assert.equal(
      parseFrameioToggleIntent('turn off frame upload for 2612B')?.projectRef?.number,
      '2612B',
    )
  })

  it('no frame token → null', () => {
    assert.equal(parseFrameioToggleIntent('turn off the upload please'), null)
  })

  it('"frame rate is off" → null (avoid editing-chatter false positive)', () => {
    assert.equal(parseFrameioToggleIntent('the frame rate is off on shot 4'), null)
  })

  it('"adjust the keyframe" → null', () => {
    assert.equal(parseFrameioToggleIntent('can you adjust the keyframe timing?'), null)
  })

  it('no toggle/status word → null', () => {
    assert.equal(parseFrameioToggleIntent('the frame.io review looks great'), null)
  })
})
