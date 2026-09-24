/**
 * Health probes — cheap "is this integration actually reachable & authed?"
 * checks, plus a pure cron-freshness evaluator.
 *
 * Each integration probe exercises the real auth path (token refresh + one
 * lightweight authed call) so a dead credential — like the Dropbox refresh
 * trio going missing — shows up as red instead of silently breaking a cron.
 * Every probe is wrapped so a failure becomes a CheckResult, never a throw.
 */

import { dropboxRpc } from '../dropbox/client'
import { frameioHeaders } from '../frameio/auth'
import { createAdminClient } from '../supabase/admin'
import { outboxDb } from '../control-center/outbox'
import { listTranscriptFiles, driveTranscriptsFolderId } from '../integrations/drive-transcripts'
import type { CheckResult, Status } from './diff'
import { runHealthProbe as probe } from './probe'

/**
 * Run every integration probe concurrently. Google is only probed when a
 * service account + transcripts folder are configured (otherwise the feature
 * is off, not broken, and a red light would be misleading).
 */
export async function runIntegrationProbes(): Promise<CheckResult[]> {
  const probes: Array<Promise<CheckResult>> = [
    probe('control-outbox', 'Control requests and alerts', async (signal) => {
      const { data, error } = await outboxDb().from('kit_control_outbox').select('id,status,created_at')
        .neq('status', 'sent').order('created_at').limit(20).abortSignal(signal)
      if (error) throw new Error('Control outbox could not be inspected')
      const stuck = data?.find(row => row.status === 'review' || Date.now() - Date.parse(row.created_at) > 15 * 60_000)
      if (stuck) throw new Error(`Request ${stuck.id} ${stuck.status === 'review' ? 'needs manual review' : 'is overdue'}`)
      return 'no overdue or unconfirmed control requests'
    }),
    probe('dropbox', 'Dropbox', async () => {
      // /check/user is Dropbox's canonical authed no-op: echoes `query` back.
      const res = await dropboxRpc('/check/user', { query: 'kit-health' })
      if (res?.result !== 'kit-health') throw new Error('unexpected check/user response')
    }),
    probe('frameio', 'Frame.io', async (signal) => {
      const res = await fetch('https://api.frame.io/v4/me', {
        headers: await frameioHeaders(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      })
      if (!res.ok) throw new Error(`GET /v4/me ${res.status}: ${(await res.text()).slice(0, 120)}`)
    }),
    probe('harvest', 'Harvest', async (signal) => {
      const token = process.env.HARVEST_ACCESS_TOKEN
      const account = process.env.HARVEST_ACCOUNT_ID
      if (!token || !account) throw new Error('HARVEST_ACCESS_TOKEN / HARVEST_ACCOUNT_ID not set')
      const res = await fetch('https://api.harvestapp.com/v2/company', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Harvest-Account-Id': account,
          'User-Agent': 'Kit Health (steve@rangerandfox.tv)',
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      })
      if (!res.ok) throw new Error(`GET /v2/company ${res.status}`)
    }),
    probe('supabase', 'Supabase', async (signal) => {
      const { error } = await createAdminClient().from('projects').select('id').limit(1).abortSignal(signal)
      if (error) throw new Error(error.message)
    }),
    probe('dropbox-inbox', 'Dropbox delivery queue', async (signal) => {
      const { data, error } = await createAdminClient()
        .from('dropbox_event_inbox')
        .select('id, event_type, last_error')
        .eq('status', 'dead_letter')
        .limit(1)
        .abortSignal(signal)
      if (error) throw new Error(error.message)
      if (data?.length) {
        const event = data[0]
        throw new Error(`${event.event_type} requires manual review: ${event.last_error || event.id}`)
      }
      return 'no dead-lettered events'
    }),
  ]

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && driveTranscriptsFolderId()) {
    probes.push(
      probe('google', 'Google Drive', async () => {
        await listTranscriptFiles(1) // exercises the service-account JWT + Drive API
      }),
    )
  }

  return Promise.all(probes)
}

// ─── Cron freshness ───────────────────────────────────────────
// A cron that silently stops firing (or errors before finishing) is the
// failure class that hid the Dropbox outage for months. Each tracked cron
// stamps a heartbeat on success; if the newest heartbeat is older than the
// cron's interval allows, it's stale → red.

/** cronId → how old (minutes) its last success may be before we call it stale. */
export const CRON_MAX_AGE_MIN: Record<string, number> = {
  // Vercel / Inngest crons.
  'delivery-dropbox-scan': 15, // runs ~every minute
  'delivery-specs-scan': 15,
  'drive-transcript-scan': 45, // runs every 15 min
  'plaud-transcript-scan': 45, // runs every 15 min when enabled
  'pre-meeting-scan': 45, // runs every 15 min
  // Railway (Bolt) node-cron jobs. Previously unmonitored — a silent stall in
  // any of these was invisible on /status. Only the FREQUENT ones are tracked
  // here; weekday/daily Railway crons (pending-checkin nudge, missing-time scan,
  // celebrations, timesheet meme, Last-Share backfill) stamp heartbeats too but
  // need schedule-aware freshness (a naive max-age false-reds on weekends), so
  // they are intentionally not auto-checked yet.
  'daily-hours-reminder': 90, // runs hourly
  'dropbox-inbox-sweep': 15, // runs ~every minute (delivery mirror drain)
  'project-share-recovery': 15, // runs every 2 min
  'project-control-recovery': 20, // runs every 5 min
  'missed-checkin-reply-recovery': 15, // runs ~every minute
  'ae-render-notify': 15, // runs ~every minute
  'behance-elevenlabs-sync': 15, // runs ~every minute
  'frameio-project-link-reconcile': 90, // runs hourly
}

export const CRON_LABELS: Record<string, string> = {
  'delivery-dropbox-scan': 'Delivery queue scan',
  'delivery-specs-scan': 'Delivery specs scan',
  'drive-transcript-scan': 'Transcript ingest',
  'plaud-transcript-scan': 'Direct Plaud ingest',
  'pre-meeting-scan': 'Meeting briefings scan',
  'daily-hours-reminder': 'Daily hours reminder sweep (Railway)',
  'dropbox-inbox-sweep': 'Dropbox inbox drain (Railway)',
  'project-share-recovery': 'Project share recovery (Railway)',
  'project-control-recovery': 'Project control recovery (Railway)',
  'missed-checkin-reply-recovery': 'Hours reply recovery (Railway)',
  'ae-render-notify': 'AE render notifier (Railway)',
  'behance-elevenlabs-sync': 'Behance/ElevenLabs draft sync (Railway)',
  'frameio-project-link-reconcile': 'Frame.io project link reconcile (Railway)',
}

/**
 * Pure: given the last-success timestamp per cron (ISO strings; missing =
 * never seen), decide freshness. A cron with no heartbeat yet is reported
 * healthy with an "awaiting first run" note so a fresh deploy doesn't alarm.
 */
export function checkCronFreshness(
  heartbeats: Record<string, string | null | undefined>,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): CheckResult[] {
  return Object.keys(CRON_MAX_AGE_MIN)
    .filter((cronId) => {
      if (cronId === 'drive-transcript-scan') return env.DRIVE_TRANSCRIPTS_ENABLED === 'true'
      if (cronId === 'plaud-transcript-scan') return env.PLAUD_INGEST_ENABLED === 'true'
      return true
    })
    .map((cronId) => {
      const label = CRON_LABELS[cronId] || cronId
      const key = `cron:${cronId}`
      const last = heartbeats[cronId]
      if (!last) return { key, label, ok: false, detail: 'no successful heartbeat recorded' }
      const ageMin = (now.getTime() - Date.parse(last)) / 60_000
      const maxAge = CRON_MAX_AGE_MIN[cronId]
      if (Number.isNaN(ageMin)) return { key, label, ok: false, detail: 'invalid heartbeat timestamp' }
      if (ageMin > maxAge) {
        return { key, label, ok: false, detail: `no success in ${Math.round(ageMin)}m (limit ${maxAge}m)` }
      }
      return { key, label, ok: true, detail: `last ran ${Math.round(ageMin)}m ago` }
    })
}
