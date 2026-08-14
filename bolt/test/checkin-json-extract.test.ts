import { describe, it, expect } from 'vitest'

import { extractJsonObject } from '../src/checkins/reply'

describe('extractJsonObject', () => {
  it('returns a bare JSON object unchanged', () => {
    const s = '{"skip":false,"entries":[]}'
    expect(extractJsonObject(s)).toBe(s)
  })

  it('unwraps a ```json fenced block', () => {
    const out = extractJsonObject('```json\n{"skip":true,"entries":[]}\n```')
    expect(JSON.parse(out!)).toEqual({ skip: true, entries: [] })
  })

  it('unwraps an unlabelled fence and tolerates prose around it', () => {
    const out = extractJsonObject('Sure, here you go:\n```\n{"skip":false,"entries":[]}\n```\nHope that helps!')
    expect(JSON.parse(out!)).toEqual({ skip: false, entries: [] })
  })

  it('finds the object when the model adds unfenced prose first', () => {
    const out = extractJsonObject('Here is the JSON: {"skip":false,"entries":[{"hours":4}]}')
    expect(JSON.parse(out!).entries[0].hours).toBe(4)
  })

  it('keeps braces that appear inside string values', () => {
    const out = extractJsonObject('{"notes":"fixed the {weird} rig","hours":2}')
    expect(JSON.parse(out!).notes).toBe('fixed the {weird} rig')
  })

  it('handles escaped quotes without ending the object early', () => {
    const out = extractJsonObject('{"notes":"called it \\"final\\" again","hours":1}')
    expect(JSON.parse(out!).hours).toBe(1)
  })

  // The exact production failure: max_tokens cut the response mid-object, and
  // the old fence-stripping regex reported "non-JSON". A truncated object must
  // yield null so the caller fails loudly instead of logging partial hours.
  it('returns null for a response truncated mid-object', () => {
    const truncated = `\`\`\`json
{
  "skip": false,
  "entries": [
    {
      "projectQuery": "2631",
      "hours": 4,
      "notes": null,
      "date": null
    },
    {
      "projectQuery": "hbcu",
      "hours"`
    expect(extractJsonObject(truncated)).toBe(null)
  })

  it('returns null for empty or object-free input', () => {
    expect(extractJsonObject('')).toBe(null)
    expect(extractJsonObject(null)).toBe(null)
    expect(extractJsonObject(undefined)).toBe(null)
    expect(extractJsonObject('I could not parse that.')).toBe(null)
  })

  it('stops at the first complete object when several follow', () => {
    const out = extractJsonObject('{"skip":false,"entries":[]} {"skip":true,"entries":[]}')
    expect(JSON.parse(out!)).toEqual({ skip: false, entries: [] })
  })
})
