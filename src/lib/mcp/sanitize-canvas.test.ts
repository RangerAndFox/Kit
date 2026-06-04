/**
 * Tests for sanitizeCanvasMarkdown — the post-turndown cleanup that makes
 * cloned canvases reproduce the template exactly.
 *
 * Run: npx tsx --test src/lib/mcp/sanitize-canvas.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeCanvasMarkdown } from './slack'

describe('sanitizeCanvasMarkdown', () => {
  it('unescapes brackets', () => {
    assert.equal(sanitizeCanvasMarkdown('\\[Foo\\]'), '[Foo]')
  })

  it('unescapes underscores (incl. inside emoji shortcodes)', () => {
    assert.equal(
      sanitizeCanvasMarkdown(':telephone\\_receiver:'),
      ':telephone_receiver:',
    )
  })

  it('keeps emoji shortcodes intact (does NOT convert to Unicode)', () => {
    const input = '## :email: Email note from client'
    const out = sanitizeCanvasMarkdown(input)
    assert.match(out, /:email:/)
    assert.doesNotMatch(out, /✉️|📧/)
  })

  it('unescapes a pipe in a heading', () => {
    const input = '## :email: Email note from client \\| 05.01'
    const out = sanitizeCanvasMarkdown(input)
    assert.match(out, /Email note from client \| 05\.01/)
    assert.doesNotMatch(out, /\\\|/)
  })

  it('preserves escaped pipes INSIDE table rows', () => {
    const input = '| cell a \\| still a | cell b |'
    const out = sanitizeCanvasMarkdown(input)
    // table row starts with '|', so the inner escaped pipe is left alone
    assert.match(out, /\\\|/)
  })

  it('reproduces the Notes template body faithfully', () => {
    // What turndown would emit for the Notes canvas (escaped pipes, intact
    // shortcodes). Sanitizer should yield the template's exact markdown.
    const turndownish = [
      '# 2xxx Notes',
      '',
      '## :email: Email note from client \\| 05.01',
      '',
      'Here is the email',
      '',
      '## :telephone_receiver: Call note from client \\| 05.01',
      '',
      'Here is the call note',
      '',
      '## :speech_balloon: Chat note from client \\| 05.01',
      '',
      'Here is the chat note',
    ].join('\n')

    const expected = [
      '# 2xxx Notes',
      '',
      '## :email: Email note from client | 05.01',
      '',
      'Here is the email',
      '',
      '## :telephone_receiver: Call note from client | 05.01',
      '',
      'Here is the call note',
      '',
      '## :speech_balloon: Chat note from client | 05.01',
      '',
      'Here is the chat note',
    ].join('\n')

    assert.equal(sanitizeCanvasMarkdown(turndownish), expected)
  })
})
