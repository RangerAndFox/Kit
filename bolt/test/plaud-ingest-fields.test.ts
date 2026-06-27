import { describe, it, expect } from 'vitest'

import { buildIngestedFields } from '../../src/lib/integrations/plaud'

describe('buildIngestedFields', () => {
  const transcript = { text: 'Hello world.', speakers: [] }
  const file = {
    name: 'Client kickoff',
    duration_seconds: 1830,
    created_at: '2026-06-20T17:00:00Z',
    participants: ['Jared', 'Alice', 'Bob'],
  }

  it('persists participants and duration (not just the transcript)', () => {
    const fields = buildIngestedFields(transcript as any, file as any)
    expect(fields).toEqual({
      transcript: 'Hello world.',
      participants: ['Jared', 'Alice', 'Bob'],
      duration_seconds: 1830,
      start_time: '2026-06-20T17:00:00Z',
      ingest_status: 'ingested',
    })
  })

  it('nulls metadata the File API omitted, keeps the transcript', () => {
    const fields = buildIngestedFields(transcript as any, { name: 'x' } as any)
    expect(fields.participants).toBeNull()
    expect(fields.duration_seconds).toBeNull()
    expect(fields.start_time).toBeNull()
    expect(fields.transcript).toBe('Hello world.')
    expect(fields.ingest_status).toBe('ingested')
  })
})
