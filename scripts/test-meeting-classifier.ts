// @ts-nocheck
/**
 * Smoke test for the meeting classifier.
 *
 * Skips if ANTHROPIC_API_KEY is not in env — does NOT fail in that case.
 * When the key is present, runs three fixture events against fixture
 * projects and prints the classifier's responses for sanity-checking.
 *
 * Run with: npx tsx scripts/test-meeting-classifier.ts
 */

import { classifyMeeting } from '../src/lib/agent/meeting-classifier'

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIP — ANTHROPIC_API_KEY not set; cannot exercise classifier live.')
  process.exit(0)
}

const projects = [
  {
    id: 'p-rayfin',
    name: 'Rayfin Overview Reel',
    client: 'Rayfin Industries',
    project_code: '2655',
    brief_summary: 'Hero brand reel for Rayfin Industries Q3 launch.',
    team_emails: ['alice@rangerandfox.tv', 'producer@rangerandfox.tv'],
  },
  {
    id: 'p-microsoft',
    name: 'Microsoft Surface Launch',
    client: 'Microsoft',
    project_code: '2701',
    brief_summary: 'Surface Studio reveal launch sizzle for Microsoft.',
    team_emails: ['bob@rangerandfox.tv', 'producer@rangerandfox.tv'],
  },
]

const events = [
  {
    event_id: 'cal:e1',
    calendar_id: 'team@rangerandfox.tv',
    summary: 'Rayfin sync — hero shot review',
    description: 'Catch up on V3 with the producer',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 60 * 60_000).toISOString(),
    attendees: [
      { email: 'alice@rangerandfox.tv' },
      { email: 'someone@rayfin.com' },
    ],
  },
  {
    event_id: 'cal:e2',
    calendar_id: 'team@rangerandfox.tv',
    summary: 'Microsoft 2701 weekly',
    description: '',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 60 * 60_000).toISOString(),
    attendees: [{ email: 'bob@rangerandfox.tv' }],
  },
  {
    event_id: 'cal:e3',
    calendar_id: 'team@rangerandfox.tv',
    summary: 'Studio standup',
    description: 'Internal weekly',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 60 * 60_000).toISOString(),
    attendees: [{ email: 'producer@rangerandfox.tv' }],
  },
]

async function main() {
  let failed = 0
  for (const ev of events) {
    const res = await classifyMeeting(ev, projects)
    console.log(`Event "${ev.summary}":`)
    console.log(`  project: ${res.project_id ?? '(none)'}  confidence: ${res.confidence.toFixed(2)}`)
    console.log(`  reasoning: ${res.reasoning}`)
    console.log('')
  }

  if (failed) process.exit(1)
  console.log('Done.')
}

main().catch((err) => { console.error(err); process.exit(1) })
