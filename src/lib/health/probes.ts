// @ts-nocheck
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
import { listTranscriptFiles, driveTranscriptsFolderId } from '../integrations/drive-transcripts'
import type { CheckResult, Status } from './diff'

const PROBE_TIMEOUT_MS = 10_000

/** Wrap a probe fn: time it, catch anything, produce a CheckResult. */
async function probe(
  key: string,
  label: string,
  fn: () => Promise<string | void>,
): Promise<CheckResult> {
  const started = Date.now()
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ])
    const ms = Date.now() - started
    return { key, label, ok: true, detail: detail || `${ms}ms` }
  } catch (err: any) {
    return { key, label, ok: false, detail: String(err?.message || err).slice(0, 300) }
  }
}

/**
 * Run every integration probe concurrently. Google is only probed when a
 * service account + transcripts folder are configured (otherwise the feature
 * is off, not broken, and a red light would be misleading).
 */
export async function runIntegrationProbes(): Promise<CheckResult[]> {
  const probes: Array<Promise<CheckResult>> = [
    probe('dropbox', 'Dropbox', async () => {
      // /check/user is Dropbox's canonical authed no-op: echoes `query` back.
      const res = await dropboxRpc('/check/user', { query: 'kit-health' })
      if (res?.result !== 'kit-health') throw new Error('unexpected check/user response')
    }),
    probe('frameio', 'Frame.io', async () => {
      const res = await fetch('https://api.frame.io/v4/me', {
        headers: await frameioHeaders(),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`GET /v4/me ${res.status}: ${(await res.text()).slice(0, 120)}`)
    }),
    probe('harvest', 'Harvest', async () => {
      const token = process.env.HARVEST_ACCESS_TOKEN
      const account = process.env.HARVEST_ACCOUNT_ID
      if (!token || !account) throw new Error('HARVEST_ACCESS_TOKEN / HARVEST_ACCOUNT_ID not set')
      const res = await fetch('https://api.harvestapp.com/v2/company', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Harvest-Account-Id': account,
          'User-Agent': 'Kit Health (steve@rangerandfox.tv)',
        },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`GET /v2/company ${res.status}`)
    }),
    probe('supabase', 'Supabase', async () => {
      const { error } = await createAdminClient().from('projects').select('id').limit(1)
      if (error) throw new Error(error.message)
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
  'delivery-dropbox-scan': 15, // runs ~every minute
  'delivery-specs-scan': 15,
  'drive-transcript-scan': 45, // runs every 15 min
  'pre-meeting-scan': 45, // runs every 15 min
}

export const CRON_LABELS: Record<string, string> = {
  'delivery-dropbox-scan': 'Delivery queue scan',
  'delivery-specs-scan': 'Delivery specs scan',
  'drive-transcript-scan': 'Transcript ingest',
  'pre-meeting-scan': 'Meeting briefings scan',
}

/**
 * Pure: given the last-success timestamp per cron (ISO strings; missing =
 * never seen), decide freshness. A cron with no heartbeat yet is reported
 * healthy with an "awaiting first run" note so a fresh deploy doesn't alarm.
 */
export function checkCronFreshness(
  heartbeats: Record<string, string | null | undefined>,
  now: Date = new Date(),
): CheckResult[] {
  return Object.keys(CRON_MAX_AGE_MIN).map((cronId) => {
    const label = CRON_LABELS[cronId] || cronId
    const key = `cron:${cronId}`
    const last = heartbeats[cronId]
    if (!last) return { key, label, ok: true, detail: 'awaiting first run' }
    const ageMin = (now.getTime() - Date.parse(last)) / 60_000
    const maxAge = CRON_MAX_AGE_MIN[cronId]
    if (Number.isNaN(ageMin)) return { key, label, ok: true, detail: 'unparsable heartbeat' }
    if (ageMin > maxAge) {
      return { key, label, ok: false, detail: `no success in ${Math.round(ageMin)}m (limit ${maxAge}m)` }
    }
    return { key, label, ok: true, detail: `last ran ${Math.round(ageMin)}m ago` }
  })
}
