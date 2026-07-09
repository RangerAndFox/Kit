import { describe, it, expect } from 'vitest'

import { splitIntoSentences, framesFromSentences } from '../../src/lib/storyboard/parser'

describe('splitIntoSentences', () => {
  it('splits on real sentence boundaries', () => {
    expect(splitIntoSentences('Open on a city. Cut to a face. Fade out.')).toEqual([
      'Open on a city.',
      'Cut to a face.',
      'Fade out.',
    ])
  })

  it('does NOT split multi-dot abbreviations before a capital word', () => {
    // The bug: "U.S." was only half-masked, splitting before "Government".
    expect(splitIntoSentences('The U.S. Government acted fast.')).toEqual([
      'The U.S. Government acted fast.',
    ])
    expect(splitIntoSentences('See e.g. The Matrix for reference.')).toEqual([
      'See e.g. The Matrix for reference.',
    ])
  })

  it('treats listed abbreviations as non-boundaries (accepted trade-off)', () => {
    // Masking ALL dots in "U.S." means it never triggers a split — the right
    // call for the common mid-phrase case ("U.S. Government"). The rare case
    // where it truly ends a sentence merges into the next; a producer can
    // split that one frame. This is intentional, not the old half-masked bug.
    expect(splitIntoSentences('I moved to the U.S. The weather is nice.')).toEqual([
      'I moved to the U.S. The weather is nice.',
    ])
  })

  it('handles single-dot honorifics (Mr., Dr.)', () => {
    expect(splitIntoSentences('Mr. Smith arrived. Dr. Jones followed.')).toEqual([
      'Mr. Smith arrived.',
      'Dr. Jones followed.',
    ])
  })

  it('returns [] for empty input', () => {
    expect(splitIntoSentences('')).toEqual([])
  })
})

describe('framesFromSentences', () => {
  it('maps each sentence to a numbered frame with sound set', () => {
    const frames = framesFromSentences('One. Two.')
    expect(frames).toEqual([
      { label: '1', sound: 'One.', action: '' },
      { label: '2', sound: 'Two.', action: '' },
    ])
  })
})
