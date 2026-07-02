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
