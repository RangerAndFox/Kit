// @ts-nocheck
/**
 * Google Calendar integration (service-account auth).
 *
 * Spec: docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md
 *
 * Service account approach: one shared service account reads N calendars
 * the studio has shared with its email. No per-user OAuth required.
 *
 * All fetch operations are gated by GOOGLE_CALENDAR_INGEST_ENABLED.
 */

import { google } from 'googleapis'

export interface CalendarEvent {
  event_id: string
  calendar_id: string
  summary: string
  description?: string
  start_time: string
  end_time: string
  attendees: Array<{ email: string; displayName?: string; responseStatus?: string }>
  organizer?: { email: string; displayName?: string }
  hangoutLink?: string
}

function ingestEnabled(): boolean {
  return process.env.GOOGLE_CALENDAR_INGEST_ENABLED === 'true'
}

function getServiceAccountCreds(): any {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  }
  // Allow either raw JSON or base64-encoded JSON (env-friendly).
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  try {
    return JSON.parse(json)
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON)')
  }
}

function getCalendarIds(): string[] {
  const raw = process.env.GOOGLE_CALENDAR_IDS || ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function getCalendarClient() {
  const creds = getServiceAccountCreds()
  // Options-object form. The positional JWT(email, keyFile, key, scopes)
  // constructor was removed in google-auth-library v10 — passing the key
  // positionally silently yields "No key or keyFile set", so requests go out
  // unauthenticated and Google returns 403 "unregistered callers".
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  })
  return google.calendar({ version: 'v3', auth })
}

/**
 * Fetch upcoming events from all configured calendars whose start time
 * falls between `fromIso` and `toIso`. Returns a flat list across calendars.
 *
 * Throws if the ingest flag is off — callers must gate.
 */
export async function fetchUpcomingEvents(
  fromIso: string,
  toIso: string,
): Promise<CalendarEvent[]> {
  if (!ingestEnabled()) {
    throw new Error('GOOGLE_CALENDAR_INGEST_ENABLED is false — calendar fetch is disabled')
  }
  const calendar = getCalendarClient()
  const calendarIds = getCalendarIds()
  if (calendarIds.length === 0) {
    return []
  }

  // Calendars fetch in parallel; each calendar follows nextPageToken so a
  // busy shared calendar (recurring events explode under singleEvents:true)
  // can't silently truncate — a missed event here means no briefing, ever.
  const perCalendar = await Promise.all(
    calendarIds.map(async (calendarId) => {
      const events: CalendarEvent[] = []
      let pageToken: string | undefined
      let safety = 10 // 500 events per calendar per window — loop safety cap
      do {
        const res = await calendar.events.list({
          calendarId,
          timeMin: fromIso,
          timeMax: toIso,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 50,
          pageToken,
        })
        for (const ev of res.data.items || []) {
          if (!ev.id || !ev.start?.dateTime) continue
          events.push({
            event_id: `${calendarId}:${ev.id}`,
            calendar_id: calendarId,
            summary: ev.summary || '',
            description: ev.description || undefined,
            start_time: ev.start.dateTime,
            end_time: ev.end?.dateTime || ev.start.dateTime,
            attendees: (ev.attendees || []).map((a) => ({
              email: a.email || '',
              displayName: a.displayName || undefined,
              responseStatus: a.responseStatus || undefined,
            })),
            organizer: ev.organizer
              ? { email: ev.organizer.email || '', displayName: ev.organizer.displayName || undefined }
              : undefined,
            hangoutLink: ev.hangoutLink || undefined,
          })
        }
        pageToken = res.data.nextPageToken || undefined
      } while (pageToken && safety-- > 0)
      return events
    }),
  )
  return perCalendar.flat()
}
