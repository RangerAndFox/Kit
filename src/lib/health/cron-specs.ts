import type { CronSpec } from './cron-schedule'
import { z } from 'zod'
export const RAILWAY_CRON_IDS = new Set([
  'daily-hours-reminder','dropbox-inbox-sweep','project-share-recovery','project-control-recovery',
  'missed-checkin-reply-recovery','ae-render-notify','behance-elevenlabs-sync',
  'frameio-project-link-reconcile','pending-checkin-nudge','missing-time-scan','daily-celebrations',
])
export function getCronSpecs(env: Record<string,string|undefined> = process.env): Record<string,CronSpec> {
const STUDIO_TZ = env.CHECKIN_TIMEZONE || 'America/Los_Angeles'
const WEEKDAYS = [1, 2, 3, 4, 5]

/** Every monitored cron and how to judge its freshness. */
return {
  // ── Vercel / Inngest crons (interval) ──
  'delivery-dropbox-scan': { kind: 'interval', label: 'Delivery queue scan', maxAgeMin: 15 },
  'delivery-specs-scan': { kind: 'interval', label: 'Delivery specs scan', maxAgeMin: 15 },
  'drive-transcript-scan': {
    kind: 'interval', label: 'Transcript ingest', maxAgeMin: 45,
    enabled: (env) => env.DRIVE_TRANSCRIPTS_ENABLED === 'true',
  },
  'plaud-transcript-scan': {
    kind: 'interval', label: 'Direct Plaud ingest', maxAgeMin: 45,
    enabled: (env) => env.PLAUD_INGEST_ENABLED === 'true',
  },
  'pre-meeting-scan': { kind: 'interval', label: 'Meeting briefings scan', maxAgeMin: 45 },

  // ── Railway (Bolt) interval crons ──
  'daily-hours-reminder': { kind: 'interval', label: 'Daily hours reminder sweep (Railway)', maxAgeMin: 90 },
  'dropbox-inbox-sweep': { kind: 'interval', label: 'Dropbox inbox drain (Railway)', maxAgeMin: 15 },
  'project-share-recovery': { kind: 'interval', label: 'Project share recovery (Railway)', maxAgeMin: 15 },
  'project-control-recovery': { kind: 'interval', label: 'Project control recovery (Railway)', maxAgeMin: 20 },
  'missed-checkin-reply-recovery': { kind: 'interval', label: 'Hours reply recovery (Railway)', maxAgeMin: 15 },
  'ae-render-notify': { kind: 'interval', label: 'AE render notifier (Railway)', maxAgeMin: 15 },
  'behance-elevenlabs-sync': { kind: 'interval', label: 'Behance/ElevenLabs draft sync (Railway)', maxAgeMin: 15 },
  'frameio-project-link-reconcile': { kind: 'interval', label: 'Frame.io project link reconcile (Railway)', maxAgeMin: 90 },

  // ── Railway (Bolt) schedule-aware crons (weekday/daily wall-clock) ──
  'pending-checkin-nudge': {
    kind: 'daily', label: 'Pending check-in nudge (Railway)',
    hour: 9, minute: 0, tz: STUDIO_TZ, days: WEEKDAYS, graceMin: 120,
  },
  'missing-time-scan': {
    kind: 'daily', label: 'Missing-time monitor (Railway)',
    hour: 9, minute: 0, tz: STUDIO_TZ, days: WEEKDAYS, graceMin: 120,
  },
  'daily-celebrations': {
    kind: 'daily', label: 'Daily celebrations (Railway)',
    hour: 9, minute: 0, tz: STUDIO_TZ, graceMin: 120,
    // Disabled without a team channel; the owning worker publishes this setting.
    enabled: (env) => !!env.KIT_TEAM_CHANNEL_ID,
  },
}

}
export interface CronRegistration {
  owner: 'railway' | 'vercel'
  enabled: boolean
  spec: CronSpec
  enrolledAt: string | null
}
const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), label: z.string(), maxAgeMin: z.number().positive().finite() }),
  z.object({ kind: z.literal('daily'), label: z.string(), hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59), tz: z.string(), graceMin: z.number().nonnegative().finite(),
    days: z.array(z.number().int().min(0).max(6)).min(1).optional() }),
])
export function parseRegistration(id: string, row: {
  owner_runtime: string | null; enabled: boolean | null; schedule: unknown; enrolled_at: string | null
}): CronRegistration | undefined {
  if (!row.owner_runtime && row.schedule === null) return undefined
  const owner = RAILWAY_CRON_IDS.has(id) ? 'railway' : 'vercel'
  if (row.owner_runtime !== owner || typeof row.enabled !== 'boolean' ||
    !row.enrolled_at || !Number.isFinite(Date.parse(row.enrolled_at))) throw new Error('Invalid cron owner/enrollment')
  const spec = scheduleSchema.parse(row.schedule)
  if (spec.kind === 'daily') new Intl.DateTimeFormat('en-US', { timeZone: spec.tz }).format()
  return { owner, enabled: row.enabled, spec, enrolledAt: row.enrolled_at }
}
export function cronDefinition(id: string, env: Record<string,string|undefined> = process.env) {
  const spec = getCronSpecs(env)[id]
  if (!spec) return null
  const { enabled, ...schedule } = spec
  return { owner: RAILWAY_CRON_IDS.has(id) ? 'railway' as const : 'vercel' as const,
    enabled: enabled ? enabled(env) : true, schedule }
}
