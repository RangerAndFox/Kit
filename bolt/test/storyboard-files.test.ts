import { describe, expect, it } from 'vitest'

describe('storyboard script files', () => {
  it('ships the Word-document reader as a Bolt runtime dependency', async () => {
    const mammoth = await import('mammoth')

    expect(mammoth.default.convertToHtml).toBeTypeOf('function')
  })
})
