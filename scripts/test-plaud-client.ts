/**
 * Standalone smoke tests for Plaud's pure parsing/frontier helpers.
 * Run with: npx tsx scripts/test-plaud-client.ts
 */

import {
  filterPlaudRecordingsSince,
  parsePlaudTranscriptContent,
} from '../src/lib/integrations/plaud'

const parsed = parsePlaudTranscriptContent(JSON.stringify([
  { start_time: 0, speaker: 'Steve', content: 'Hello' },
  { start_time: 65_000, speaker: 'Client', content: 'Hi there' },
]))

const filtered = filterPlaudRecordingsSince(
  [
    { id: 'old', created_at: '2026-01-01T00:00:00Z' },
    { id: 'new', created_at: '2026-08-01T00:00:00Z' },
  ],
  '2026-07-01T00:00:00Z',
)

const checks: Array<[string, boolean]> = [
  ['formats timestamped speaker turns', parsed.text === '[00:00] Steve: Hello\n[01:05] Client: Hi there'],
  ['extracts unique participants', parsed.participants.map((p) => p.name).join(',') === 'Steve,Client'],
  ['filters recordings at the cutover frontier', filtered.length === 1 && filtered[0]?.id === 'new'],
  ['preserves plain-text transcripts', parsePlaudTranscriptContent('plain transcript').text === 'plain transcript'],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}
if (failed) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll Plaud client checks passed.')
