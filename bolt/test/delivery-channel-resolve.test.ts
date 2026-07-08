import { describe, it, expect } from 'vitest'

import { deliveryQueueProjectFolder } from '../../src/lib/delivery/dropbox-watcher'

describe('deliveryQueueProjectFolder', () => {
  it('extracts the project folder segment', () => {
    expect(deliveryQueueProjectFolder('/Delivery-Queue/Magic Quadrant/Spot_V2.mov')).toBe(
      'Magic Quadrant',
    )
    expect(deliveryQueueProjectFolder('/delivery-queue/rainforest-expo/subs/Spot.srt')).toBe(
      'rainforest-expo',
    )
  })

  it('returns null for root-level files', () => {
    expect(deliveryQueueProjectFolder('/Delivery-Queue/loose-file.mov')).toBeNull()
  })

  it('returns null for unrelated paths', () => {
    expect(deliveryQueueProjectFolder('/Projects/Acme/file.mov')).toBeNull()
  })
})
