import { describe, expect, it } from 'vitest'

import {
  selectResumeProject,
  selectResumeStoryboard,
} from '../../src/lib/boords/client'

describe('Boords timeout reconciliation', () => {
  it('reuses the exact project created by a timed-out request', () => {
    const project = selectResumeProject([
      { id: 'old', name: 'Other project' },
      {
        id: 'current',
        name: '2633 | Microsoft | Business Apps',
        description: '16:9 • 5s per frame',
      },
    ], '2633 | Microsoft | Business Apps', '16:9 • 5s per frame')

    expect(project?.id).toBe('current')
  })

  it('does not guess when duplicate projects are ambiguous', () => {
    expect(selectResumeProject([
      { id: 'one', name: 'Same name' },
      { id: 'two', name: 'Same name' },
    ], 'Same name')).toBeNull()
  })

  it('reuses a storyboard that Boords created before its response timed out', () => {
    const storyboard = selectResumeStoryboard([
      { id: 'existing', name: 'Campaign board', url: 'https://app.boords.com/storyboards/existing' },
    ], 'Campaign board')

    expect(storyboard?.id).toBe('existing')
  })
})
