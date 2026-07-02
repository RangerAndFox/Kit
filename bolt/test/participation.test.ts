import { describe, it, expect, beforeEach } from 'vitest'

import {
  looksAddressable,
  underCooldown,
  threadAlreadyAnswered,
  _resetParticipationStateForTest,
} from '../src/participation/participant'

describe('looksAddressable (participation prefilter)', () => {
  it('accepts knowledge questions', () => {
    expect(looksAddressable("what's the delivery date for this one?")).toBe(true)
    expect(looksAddressable('do we know what codec they want?')).toBe(true)
  })

  it('accepts asset requests without question marks', () => {
    expect(looksAddressable('can someone send the latest cut')).toBe(true)
    expect(looksAddressable("where's the dropbox folder for selects")).toBe(true)
    expect(looksAddressable('link to the frame.io please')).toBe(true)
  })

  it('skips messages addressed to a specific person', () => {
    expect(looksAddressable('<@U123> what do you think about the end card?')).toBe(false)
  })

  it('skips trivial chatter and reactions', () => {
    expect(looksAddressable('sounds good')).toBe(false)
    expect(looksAddressable('+1')).toBe(false)
    expect(looksAddressable('ok')).toBe(false)
  })

  it('skips bare link pastes', () => {
    expect(looksAddressable('https://app.frame.io/reviews/abc-123')).toBe(false)
    expect(looksAddressable('<https://app.frame.io/player/xyz|v3 cut>')).toBe(false)
  })

  it('skips statements that are neither questions nor asset requests', () => {
    expect(looksAddressable('uploaded the new selects to the drive this morning')).toBe(false)
  })

  it('skips extremely long messages', () => {
    expect(looksAddressable('why? '.repeat(200))).toBe(false)
  })
})

describe('participation rate limiting', () => {
  beforeEach(() => _resetParticipationStateForTest())

  it('starts with no cooldown and no answered threads', () => {
    expect(underCooldown('C1')).toBe(false)
    expect(threadAlreadyAnswered('C1', '111.222')).toBe(false)
  })
})

describe('participation context helpers', () => {
  it('gates Frame.io comment fetching on review-flavored messages', async () => {
    const { wantsFrameioComments } = await import('../src/participation/context')
    expect(wantsFrameioComments('did the client leave notes on v3?')).toBe(true)
    expect(wantsFrameioComments('any feedback on the latest cut?')).toBe(true)
    expect(wantsFrameioComments('what codec are we delivering in?')).toBe(false)
  })

  it('parses a Frame.io project id from a stored URL', async () => {
    const { parseFrameioProjectId } = await import('../src/participation/context')
    expect(
      parseFrameioProjectId('https://app.frame.io/projects/6d1c0769-5205-4c2b-8a0a-08a7aff4ca5c'),
    ).toBe('6d1c0769-5205-4c2b-8a0a-08a7aff4ca5c')
    expect(parseFrameioProjectId('https://app.frame.io/reviews/abc')).toBe(null)
    expect(parseFrameioProjectId(null)).toBe(null)
  })
})
