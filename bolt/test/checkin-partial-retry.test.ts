import { describe, it, expect } from 'vitest'

import { mergeHarvestEntryIds } from '../src/checkins/confirm'

describe('partial check-in retry safety', () => {
  it('preserves prior successful Harvest ids and appends the corrected line', () => {
    expect(mergeHarvestEntryIds([101, 102, 103], [104])).toEqual([101, 102, 103, 104])
  })

  it('deduplicates a retried webhook response', () => {
    expect(mergeHarvestEntryIds([101, 102], [102, 103])).toEqual([101, 102, 103])
  })

  it('tolerates an empty legacy id field', () => {
    expect(mergeHarvestEntryIds(null, [104])).toEqual([104])
  })
})
