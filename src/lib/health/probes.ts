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
import { assertNoStalledDeliveryReceipts } from '../slack/durable-delivery'
import { listTranscriptFiles, driveTranscriptsFolderId } from '../integrations/drive-transcripts'
import type { CheckResult, Status } from './diff'
import { runHealthProbe as probe } from './probe'
import { mostRecentScheduledFire } from './cron-schedule'
import { getCronSpecs, RAILWAY_CRON_IDS, type CronRegistration } from './cron-specs'

/**
 * Run every integration probe concurrently. Google is only probed when a
 * service account + transcripts folder are configured (otherwise the feature
 * is off, not broken, and a red light would be misleading).
 */
export async function runIntegrationProbes(): Promise<CheckResult[]> {
  const probes: Array<Promise<CheckResult>> = [
    probe('delivery-notifications', 'Delivery notification receipts', assertNoStalledDeliveryReceipts),
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
        .is('retired_at', null)
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
// stamps a heartbeat: an ATTEMPT when the tick starts and a SUCCESS only when
// its pass completes. The watchdog uses both — a fresh attempt with a stale
// success is "running but failing", both stale is "not running at all". Crons
// on a wall-clock schedule (weekday 09:00 etc.) are evaluated against their
// next expected fire, DST- and weekend-correct, not a naive max-age.

/** One-time persistent monitor-enrollment grace for never-seen crons. */
export const STARTUP_GRACE_MIN = 30

// Railway publishes its actual timezone and enablement; Vercel consumes those
// values rather than guessing from its own environment.
export { getCronSpecs } from './cron-specs'

interface HeartbeatState { success: string | null; attempt: string | null; registration?: CronRegistration }

/** Legacy string heartbeats are treated as success-only. */
function normalizeHeartbeat(hb: HeartbeatState | string | null | undefined): HeartbeatState {
  if (hb == null) return { success: null, attempt: null }
  if (typeof hb === 'string') return { success: hb, attempt: null }
  return { success: hb.success ?? null, attempt: hb.attempt ?? null, registration: hb.registration }
}

function fmtAgo(now: Date, ms: number): string {
  const min = (now.getTime() - ms) / 60_000
  if (min < 120) return `${Math.round(min)}m ago`
  return `${Math.round(min / 60)}h ago`
}

/**
 * Pure freshness evaluator. For each enabled cron it distinguishes:
 *   green   — succeeded within its interval / since its last scheduled fire,
 *             or not yet due (within grace), or inside startup grace.
 *   red     — "attempting but not succeeding" (fresh attempt, stale success) vs
 *             "not running" (no recent attempt at all).
 * `bootAt` is the persistent monitor epoch, NOT a process/cold-start timestamp.
 */
export function checkCronFreshness(
  heartbeats: Record<string, HeartbeatState | string | null | undefined>,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  bootAt?: Date,
): CheckResult[] {
  const out: CheckResult[] = []
  for (const [cronId, configuredSpec] of Object.entries(getCronSpecs(env))) {
    const registered = normalizeHeartbeat(heartbeats[cronId]).registration
    const spec = registered?.spec ?? configuredSpec
    const key = `cron:${cronId}`
    const label = spec.label
    const hb = normalizeHeartbeat(heartbeats[cronId])
    const success = hb.success ? Date.parse(hb.success) : null
    const attempt = hb.attempt ? Date.parse(hb.attempt) : null
    // Explicit current owner configuration wins over old heartbeat history.
    // Railway jobs are never disabled by unrelated Vercel-local flags.
    const remote = RAILWAY_CRON_IDS.has(cronId)
    const disabledByConfig = registered ? !registered.enabled
      : !remote && configuredSpec.enabled ? !configuredSpec.enabled(env) : false
    if (disabledByConfig) continue
    if ((hb.success && (Number.isNaN(success!) || success! > now.getTime() + 60_000)) ||
      (hb.attempt && (Number.isNaN(attempt!) || attempt! > now.getTime() + 60_000))) {
      out.push({ key, label, ok: false, detail: 'invalid heartbeat timestamp' })
      continue
    }

    const enrolledMs = registered?.enrolledAt ? Date.parse(registered.enrolledAt) : null
    const fire = spec.kind === 'daily' ? mostRecentScheduledFire(spec, now) : null
    const graceMs = spec.kind === 'daily' ? spec.graceMin * 60_000 : 0
    const notYetDue = spec.kind === 'daily' && (!fire || now.getTime() < fire.getTime() + graceMs)
    const requiredFire = spec.kind === 'daily' && fire && notYetDue
      ? mostRecentScheduledFire(spec, new Date(fire.getTime() - 1)) : fire
    const enrolledAfterRequired = enrolledMs !== null && requiredFire !== null && enrolledMs > requiredFire.getTime()

    // Never observed: hold green through startup grace / until first fire is due.
    if (success === null && attempt === null) {
      const enrollmentGrace = enrolledMs !== null && (spec.kind === 'daily'
        ? enrolledAfterRequired : now.getTime() - enrolledMs < spec.maxAgeMin * 60_000)
      if (enrollmentGrace || (bootAt && now.getTime() - bootAt.getTime() < STARTUP_GRACE_MIN * 60_000)) {
        out.push({ key, label, ok: true, detail: 'awaiting first run (startup grace)' })
      } else if (spec.kind === 'daily' && requiredFire === null) {
        out.push({ key, label, ok: true, detail: 'awaiting first scheduled run' })
      } else {
        out.push({ key, label, ok: false, detail: 'no heartbeat recorded' })
      }
      continue
    }

    // Freshness of the last SUCCESS.
    let fresh: boolean
    if (spec.kind === 'interval') {
      fresh = success !== null && now.getTime() - success <= spec.maxAgeMin * 60_000
    } else {
      fresh = enrolledAfterRequired || (success !== null && requiredFire !== null && success >= requiredFire.getTime())
    }
    if (fresh) {
      out.push({
        key, label, ok: true,
        detail: success !== null ? `last success ${fmtAgo(now, success)}` : 'not yet due',
      })
      continue
    }

    // Stale success — is it at least still ATTEMPTING?
    const attemptFresh = spec.kind === 'interval'
      ? attempt !== null && now.getTime() - attempt <= spec.maxAgeMin * 60_000
      : attempt !== null && fire !== null && attempt >= fire.getTime()
    const succDesc = success !== null ? `last success ${fmtAgo(now, success)}` : 'no successful run'
    const attDesc = attempt !== null ? `last attempt ${fmtAgo(now, attempt)}` : 'no attempt recorded'
    out.push({
      key, label, ok: false,
      detail: attemptFresh
        ? `attempting but not succeeding (${succDesc}; ${attDesc})`
        : `not running (${succDesc}; ${attDesc})`,
    })
  }
  return out
}
