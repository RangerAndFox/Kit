import { describe, it, expect } from 'vitest'

import { parseConfirmDecision } from '../src/checkins/reply'

describe('parseConfirmDecision', () => {
  it('accepts confirm phrasings', () => {
    for (const t of [
      'yes',
      'Yes!',
      'y',
      'yep',
      'confirm',
      'Confirmed.',
      'looks good',
      'log it',
      'do it',
      '✅',
      ':white_check_mark:',
      '👍',
    ]) {
      expect(parseConfirmDecision(t), t).toBe('confirm')
    }
  })

  it('accepts redo phrasings', () => {
    for (const t of ['no', 'redo', 'Edit', 'wrong', 'try again', 'start over', '✏️']) {
      expect(parseConfirmDecision(t), t).toBe('redo')
    }
  })

  it('rejects anything that is not purely a decision', () => {
    for (const t of [
      'yes but what is the frame.io link?',
      'yesterday I did 4h on Rayfin',
      'no worries, unrelated question',
      'can you log it to Magic Quadrant instead',
      '4h on Ignite',
      '',
      'confirm the meeting for tomorrow',
    ]) {
      expect(parseConfirmDecision(t), t).toBeNull()
    }
  })

  it('rejects long messages even if they start with a keyword', () => {
    expect(parseConfirmDecision('yes '.repeat(20))).toBeNull()
  })
})
