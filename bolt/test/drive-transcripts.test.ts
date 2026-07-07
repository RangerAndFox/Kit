import { describe, it, expect } from 'vitest'

import { sanitizeTranscriptText } from '../../src/lib/integrations/drive-transcripts'
import { scoreProjectMentions } from '../../src/lib/agent/call-classifier'

describe('sanitizeTranscriptText', () => {
  it('converts <br> variants to newlines', () => {
    expect(sanitizeTranscriptText('Speaker 1 00:00:09<br>Hello.<br/>Bye.<BR >Done.')).toBe(
      'Speaker 1 00:00:09\nHello.\nBye.\nDone.',
    )
  })

  it('strips other tags and decodes common entities', () => {
    expect(sanitizeTranscriptText('<p>Tom &amp; Jerry said &quot;hi&quot;&nbsp;today</p>')).toBe(
      'Tom & Jerry said "hi" today',
    )
  })

  it('collapses runs of blank lines and trims', () => {
    expect(sanitizeTranscriptText('a<br><br><br><br>b  \n')).toBe('a\n\nb')
  })

  it('leaves plain text untouched', () => {
    const plain = 'Speaker 1 00:00:00\nJust a normal line.\n\nAnother.'
    expect(sanitizeTranscriptText(plain)).toBe(plain)
  })

  it('does not treat timestamps or comparisons as tags', () => {
    expect(sanitizeTranscriptText('costs < budget and 5 > 3')).toBe('costs < budget and 5 > 3')
  })
})

describe('scoreProjectMentions', () => {
  const project = { name: 'Magic Quadrant', client: 'MSFT', project_code: '2626-MSFT' }

  it('scores repeated name mentions', () => {
    const text = 'we reviewed magic quadrant edits. magic quadrant ships friday.'
    expect(scoreProjectMentions(text, project)).toBe(6)
  })

  it('weights project codes highest', () => {
    // code hit (5) plus the client substring inside it (capped count, 1)
    expect(scoreProjectMentions('billing against 2626-msft this week', project)).toBe(5 + 1)
  })

  it('caps client-only mentions so a generic client cannot dominate', () => {
    const text = 'msft msft msft msft msft'
    expect(scoreProjectMentions(text, project)).toBe(2)
  })

  it('ignores short fields that would false-positive everywhere', () => {
    const shortName = { name: 'Gov', client: 'Azure', project_code: null }
    expect(scoreProjectMentions('the government took over azure hills', shortName)).toBe(1)
  })

  it('returns 0 when nothing matches', () => {
    expect(scoreProjectMentions('lunch order thread', project)).toBe(0)
  })
})
