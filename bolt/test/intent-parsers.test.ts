import { describe, it, expect } from 'vitest'

import { parseRoleIntent } from '../src/roles/keyword'
import { parseFrameioToggleIntent } from '../src/delivery/frameio-toggle'

describe('parseRoleIntent (structural matching)', () => {
  it('matches explicit role-set phrasings', () => {
    expect(parseRoleIntent('make <@U123> a producer')).toEqual({
      targetSlackId: 'U123',
      role: 'producer',
      isQuery: false,
    })
    expect(parseRoleIntent("set <@U123>'s role to producer")).toMatchObject({
      role: 'producer',
    })
    expect(parseRoleIntent('promote <@U123> to admin')).toMatchObject({
      role: 'founder', // admin normalizes to founder
    })
    expect(parseRoleIntent('give <@U123> admin access')).toMatchObject({
      role: 'founder',
    })
    expect(parseRoleIntent('role <@U123> producer')).toMatchObject({
      role: 'producer',
    })
  })

  it('does NOT match incidental mention+role-word messages', () => {
    // The old bag-of-words matcher rewrote a tier from this.
    expect(
      parseRoleIntent('make sure <@U123> the artist gets the final files'),
    ).toBeNull()
    expect(parseRoleIntent('can you give <@U123> the files the producer sent')).toBeNull()
    expect(parseRoleIntent('assign the artist brief to <@U123> please')).toBeNull()
  })

  it('still supports role queries', () => {
    expect(parseRoleIntent("what's <@U123>'s role?")).toEqual({
      targetSlackId: 'U123',
      role: null,
      isQuery: true,
    })
  })

  it('requires a real mention', () => {
    expect(parseRoleIntent('make Allyson a producer')).toBeNull()
  })
})

describe('parseFrameioToggleIntent (anchor tightening)', () => {
  it('matches explicit frame.io toggles', () => {
    expect(parseFrameioToggleIntent('turn off frame.io upload for 2628')).toMatchObject({
      action: 'disable',
    })
    expect(parseFrameioToggleIntent('turn frameio back on for project 2628')).toMatchObject({
      action: 'enable',
    })
    expect(parseFrameioToggleIntent('is frame upload on for 2628?')).toMatchObject({
      action: 'status',
    })
    expect(parseFrameioToggleIntent('turn off auto upload for 2628')).toMatchObject({
      action: 'disable',
    })
  })

  it('does NOT treat editing chatter about frames as a toggle', () => {
    // The old matcher disabled the project mirror from this.
    expect(parseFrameioToggleIntent('remove the black frame at the top')).toBeNull()
    expect(parseFrameioToggleIntent('can you stop on the last frame of the intro')).toBeNull()
    expect(parseFrameioToggleIntent('skip the freeze frame')).toBeNull()
  })

  it('still ignores frame-rate/keyframe noise', () => {
    expect(parseFrameioToggleIntent('set the frame rate to 24 and stop the upload')).toBeNull()
  })
})
