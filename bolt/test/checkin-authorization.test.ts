import { describe, expect, it } from 'vitest'
import { isCheckinActorAuthorized } from '../src/checkins/confirm'

describe('daily-hours card authorization', () => {
  it('allows only the Slack user who owns the check-in', () => {
    expect(isCheckinActorAuthorized('U_OWNER', 'U_OWNER')).toBe(true)
    expect(isCheckinActorAuthorized('U_OWNER', 'U_OTHER')).toBe(false)
  })

  it('fails closed when either identity is absent', () => {
    expect(isCheckinActorAuthorized('', 'U_OWNER')).toBe(false)
    expect(isCheckinActorAuthorized('U_OWNER', '')).toBe(false)
    expect(isCheckinActorAuthorized(null, undefined)).toBe(false)
  })
})
