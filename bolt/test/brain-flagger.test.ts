import { describe, it, expect } from 'vitest'

import {
  collectCanonicalFacts,
  sanitizeMessageForMistakeCheck,
} from '../../src/lib/brain/flagger'
import { parseBrain } from '../../src/lib/brain/format'

const BRAIN_MD = `---
revision: 3
---

## Glossary

- The hero SKU is 44017
- Canonical review link: https://app.frame.io/reviews/abc-123-def
- <https://f.io/xyz789|Latest cut>

## Operating context

- Delivery is 2026-08-01 in ProRes 422
- Dropbox: https://www.dropbox.com/scl/fo/aaa111
- Budget is $50k for phase one
`

describe('collectCanonicalFacts', () => {
  const brain = parseBrain(BRAIN_MD)
  const facts = collectCanonicalFacts(brain)
  const texts = facts.map((f) => f.text)

  it('keeps real spec facts', () => {
    expect(texts).toContain('The hero SKU is 44017')
    expect(texts.some((t) => t.includes('2026-08-01'))).toBe(true)
  })

  it('skips URL bullets — link IDs are never canonical facts', () => {
    // A stored Frame.io link's ID "contradicts" every other link pasted in
    // the channel by design; these must never enter the mistake-catcher.
    expect(texts.some((t) => t.includes('frame.io'))).toBe(false)
    expect(texts.some((t) => t.includes('f.io'))).toBe(false)
    expect(texts.some((t) => t.includes('dropbox.com'))).toBe(false)
  })

  it('still skips financial bullets', () => {
    expect(texts.some((t) => t.includes('$50k'))).toBe(false)
  })
})

describe('sanitizeMessageForMistakeCheck', () => {
  it('replaces bare URLs with [link]', () => {
    expect(
      sanitizeMessageForMistakeCheck('new cut up https://app.frame.io/reviews/xyz-42 thoughts?'),
    ).toBe('new cut up [link] thoughts?')
  })

  it('replaces Slack-formatted <url|label> links', () => {
    expect(
      sanitizeMessageForMistakeCheck('see <https://app.frame.io/player/123abc|v3 cut> for notes'),
    ).toBe('see [link] for notes')
  })

  it('leaves genuine values intact', () => {
    expect(sanitizeMessageForMistakeCheck('the SKU is 44071')).toBe('the SKU is 44071')
  })
})
