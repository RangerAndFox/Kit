import type { HealthDiff } from './diff'

/** A blind monitor is not evidence of stopped jobs. Mixed incidents retain
 * separate monitoring and genuine-job headings. */
export function healthAlertText(diff: HealthDiff): string {
  const monitoring = diff.downed.filter(r => ['cron:telemetry', 'cron:configuration'].includes(r.key))
  const failures = diff.downed.filter(r => !monitoring.includes(r))
  const lines: string[] = []
  if (failures.length) {
    lines.push(':rotating_light: *Kit health — something went down*')
    for (const r of failures) lines.push(`:red_circle: *${r.label}* — ${r.detail || 'failing'}`)
  }
  if (monitoring.length) {
    lines.push(':warning: *Kit health — monitoring unavailable*')
    for (const r of monitoring) lines.push(`*${r.label}* — ${r.detail || 'unavailable'}`)
    lines.push('This does not confirm a job failure. Kit will report when monitoring recovers.')
  }
  for (const r of diff.recovered) lines.push(`:large_green_circle: *${r.label}* recovered`)
  return lines.join('\n')
}
