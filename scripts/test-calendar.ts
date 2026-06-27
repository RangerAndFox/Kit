/**
 * Verify the pre-meeting-briefing Google Calendar setup BEFORE flipping the
 * activation flag.
 *
 * Prints the service account's email (the address you must share each calendar
 * with), then, for every id in GOOGLE_CALENDAR_IDS, tries to read the next 7
 * days of events. A calendar that isn't shared with the service account comes
 * back as a 404 — so this tells you exactly which sharing step is missing.
 *
 * Run where the env vars live (Railway shell or local with .env):
 *   npx tsx scripts/test-calendar.ts
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_IDS. Independent of
 * GOOGLE_CALENDAR_INGEST_ENABLED (it's a diagnostic, not the live path).
 */

import 'dotenv/config'
import { google } from 'googleapis'

function getCreds(): any {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  return JSON.parse(json)
}

function getCalendarIds(): string[] {
  return (process.env.GOOGLE_CALENDAR_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main() {
  const creds = getCreds()
  console.log(`Service account: ${creds.client_email}`)
  console.log('→ Each calendar below must be shared with that address ("See all event details").\n')

  const ids = getCalendarIds()
  if (ids.length === 0) {
    console.log('GOOGLE_CALENDAR_IDS is empty — set it to the comma-separated calendar ids you want briefed.')
    return
  }

  const auth = new google.auth.JWT(creds.client_email, undefined, creds.private_key, [
    'https://www.googleapis.com/auth/calendar.readonly',
  ])
  const calendar = google.calendar({ version: 'v3', auth })

  const now = new Date()
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  let ok = 0
  for (const calendarId of ids) {
    try {
      const res = await calendar.events.list({
        calendarId,
        timeMin: now.toISOString(),
        timeMax: weekOut.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10,
      })
      const timed = (res.data.items || []).filter((e) => e.start?.dateTime)
      ok++
      console.log(`✓ ${calendarId}`)
      console.log(`    ${timed.length} timed event(s) in the next 7 days` +
        (timed[0] ? ` — next: "${timed[0].summary}" @ ${timed[0].start?.dateTime}` : ''))
    } catch (err: any) {
      const code = err?.code || err?.response?.status
      const hint = code === 404 ? ' (not shared with the service account, or wrong id)' : ''
      console.log(`✗ ${calendarId} — ${code || ''} ${err?.message || err}${hint}`)
    }
  }

  console.log(`\n${ok}/${ids.length} calendar(s) readable. Once all read OK, set GOOGLE_CALENDAR_INGEST_ENABLED=true.`)
}

main().catch((err) => {
  console.error('test-calendar failed:', err.message || err)
  process.exit(1)
})
