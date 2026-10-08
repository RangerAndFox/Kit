import { diffHealth, type CheckResult } from './diff'
import { healthAlertText } from './alert-text'
import { formatHealthDigest, type CheckinSummary } from './digest'
import { statusMap, type HealthRow } from './state'

export interface HealthReport {
  id: string
  observed_at: string
  recipient: string
  checks: CheckResult[]
  digest?: { summary: CheckinSummary; dateLabel: string }
}
export interface ReportPlan {
  checks: CheckResult[]
  text: string | null
  channel: string | null
}
export interface PendingReport extends HealthReport { plan: ReportPlan | null }
export interface HealthReportStore {
  enqueue(report: HealthReport): Promise<void>
  pending(): Promise<PendingReport[]>
  state(): Promise<HealthRow[]>
  plan(id: string, plan: ReportPlan): Promise<ReportPlan>
  complete(id: string): Promise<void>
}

/** Discard late snapshots; a slow, older run cannot reopen a recovered incident. */
export function planHealthReport(report: HealthReport, previous: HealthRow[]): Omit<ReportPlan, 'channel'> {
  const byKey = new Map(previous.map(row => [row.key, row]))
  const checks = report.checks.filter(check => {
    const before = byKey.get(check.key)
    return !before || Date.parse(before.checked_at) < Date.parse(report.observed_at)
  })
  const diff = diffHealth(statusMap(previous), checks)
  if (!report.digest) {
    return { checks, text: diff.downed.length || diff.recovered.length ? healthAlertText(diff) : null }
  }
  // A digest arriving late still contains its time summary, but never repeats an
  // obsolete integration incident after a newer watchdog has confirmed recovery.
  const current = report.checks.map(check => {
    const before = byKey.get(check.key)
    return checks.includes(check) || !before ? check : {
      ...check, ok: before.status === 'up', unknown: before.status === 'unknown', detail: before.detail ?? undefined,
    }
  })
  const recovery = diff.recovered.length ? '\n' + healthAlertText({ downed: [], recovered: diff.recovered }) : ''
  return { checks, text: formatHealthDigest(current, report.digest.summary, report.digest.dateLabel) + recovery }
}

/** Both Inngest callers serialize this ENTIRE operation as one env-scoped step.
 * Pending plans are immutable. Slack's existing durable receipt is reconciled
 * before the transaction commits state + completion. A crash at any boundary
 * leaves the head pending; later reports must finish it before they advance.
 */
export async function publishHealthReport(report: HealthReport, io: {
  store: HealthReportStore
  resolveDm(recipient: string): Promise<string>
  send(input: { key: string; channel: string; text: string }): Promise<unknown>
}): Promise<void> {
  await io.store.enqueue(report)
  const pending = await io.store.pending()
  for (const next of pending) {
    let plan = next.plan
    if (!plan) {
      const prepared = planHealthReport(next, await io.store.state())
      plan = await io.store.plan(next.id, { ...prepared,
        channel: prepared.text ? await io.resolveDm(next.recipient) : null })
    }
    if (plan.text) {
      if (!plan.channel) throw new Error('Health report has no private destination')
      await io.send({ key: `health-report:${next.id}`, channel: plan.channel, text: plan.text })
    }
    await io.store.complete(next.id)
  }
  // Bounded drain. Do not claim the submitting report was handled if older work
  // fills the batch; Inngest/next watchdog continues draining the durable queue.
  if (pending.length === 20) throw new Error('Health reporting backlog requires another drain')
}
