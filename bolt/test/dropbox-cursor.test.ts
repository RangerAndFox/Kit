import { describe, expect, it } from 'vitest'
import { shouldAdvanceDeliveryCursor } from '../src/watchers/dropbox.js'

describe('Dropbox delivery cursor safety', () => {
  it('advances after a fully successful batch', () => {
    expect(shouldAdvanceDeliveryCursor(0)).toBe(true)
  })

  it('does not advance when any entry failed', () => {
    expect(shouldAdvanceDeliveryCursor(1)).toBe(false)
  })
})
