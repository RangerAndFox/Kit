import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractPlaudTranscript,
  filterPlaudRecordingsSince,
  parsePlaudTranscriptContent,
} from './plaud'

describe('Plaud transcript parsing', () => {
  it('renders timestamps and speakers from Plaud transaction JSON', () => {
    const parsed = parsePlaudTranscriptContent(JSON.stringify([
      { start_time: 0, end_time: 2400, speaker: 'Steve', content: 'Hello there.' },
      { start_time: 65000, end_time: 69000, speaker: 'Client', content: 'Let us begin.' },
    ]))
    assert.equal(parsed.text, '[00:00] Steve: Hello there.\n[01:05] Client: Let us begin.')
    assert.deepEqual(parsed.participants, [{ name: 'Steve' }, { name: 'Client' }])
  })

  it('accepts plain text and leaves participants empty', () => {
    assert.deepEqual(parsePlaudTranscriptContent('A plain transcript.'), {
      text: 'A plain transcript.',
      participants: [],
    })
  })

  it('ignores empty segments and supports alternate field names', () => {
    const parsed = parsePlaudTranscriptContent(JSON.stringify([
      { start: 3000, speaker_label: 'Speaker 1', text: 'Useful.' },
      { start: 4000, speaker_label: 'Speaker 2', text: '' },
    ]))
    assert.equal(parsed.text, '[00:03] Speaker 1: Useful.')
    assert.deepEqual(parsed.participants, [{ name: 'Speaker 1' }])
  })
})

describe('Plaud historical frontier', () => {
  const recordings = [
    { id: 'old', created_at: '2026-08-14T23:59:59Z' },
    { id: 'new', created_at: '2026-08-15T00:00:00Z' },
    { id: 'started-new', created_at: '2026-08-01T00:00:00Z', start_at: '2026-08-16T00:00:00Z' },
    { id: 'bad', created_at: 'not-a-date' },
  ]

  it('only admits recordings at or after the configured cutover', () => {
    assert.deepEqual(
      filterPlaudRecordingsSince(recordings, '2026-08-15T00:00:00Z').map((recording) => recording.id),
      ['new', 'started-new'],
    )
  })

  it('requires a valid explicit cutover', () => {
    assert.throws(() => filterPlaudRecordingsSince(recordings, ''), /PLAUD_INGEST_FROM is required/)
    assert.throws(() => filterPlaudRecordingsSince(recordings, 'later'), /valid ISO-8601/)
  })
})

describe('Plaud transcript block preference', () => {
  it('falls back to raw transaction when the polished block exists but is empty', async () => {
    const parsed = await extractPlaudTranscript({
      id: 'recording',
      source_list: [
        { data_type: 'transaction_polish', data_content: '' },
        {
          data_type: 'transaction',
          data_content: JSON.stringify([{ speaker: 'Speaker 1', content: 'Raw is ready.' }]),
        },
      ],
    })
    assert.equal(parsed.text, 'Speaker 1: Raw is ready.')
  })
})
