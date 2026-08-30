'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  CloudCog,
  Coins,
  GitCommitHorizontal,
  ExternalLink,
  FolderKanban,
  Gauge,
  HeartPulse,
  History,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  TimerReset,
  TriangleAlert,
  Workflow,
  XCircle,
} from 'lucide-react'
import type {
  ActivityItem,
  ControlCenterPayload,
  HealthCheck,
  QueueSummary,
  Signal,
} from '@/lib/control-center/types'
import stylesModule from './control-center.module.css'

const REFRESH_MS = 30_000

const signalStyles: Record<Signal, { dot: string; text: string; bg: string; border: string }> = {
  healthy: { dot: 'bg-emerald-400', text: 'text-emerald-300', bg: 'bg-emerald-400/10', border: 'border-emerald-400/20' },
  warning: { dot: 'bg-amber-400', text: 'text-amber-300', bg: 'bg-amber-400/10', border: 'border-amber-400/20' },
  danger: { dot: 'bg-rose-400', text: 'text-rose-300', bg: 'bg-rose-400/10', border: 'border-rose-400/20' },
  neutral: { dot: 'bg-slate-400', text: 'text-slate-300', bg: 'bg-slate-400/10', border: 'border-slate-400/20' },
}

function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'never'
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function ControlCenter({ initialData }: { initialData: ControlCenterPayload }) {
  const [data, setData] = useState(initialData)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.parse(initialData.generatedAt))
  const [isPending, startTransition] = useTransition()

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/control-center', { cache: 'no-store' })
      if (!response.ok) throw new Error(response.status === 403 ? 'Founder access required.' : 'Live refresh failed.')
      const next = (await response.json()) as ControlCenterPayload
      startTransition(() => setData(next))
      setClock(Date.now())
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Live refresh failed.')
    }
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClock(Date.now())
      void refresh()
    }, REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [refresh])

  const status = {
    operational: { label: 'All systems operational', signal: 'healthy' as const, icon: CheckCircle2 },
    attention: { label: 'Attention recommended', signal: 'warning' as const, icon: AlertTriangle },
    incident: { label: 'Kit needs attention', signal: 'danger' as const, icon: XCircle },
  }[data.overall]
  const StatusIcon = status.icon

  return (
    <div className={stylesModule.root}>
      <div className={stylesModule.frame}>
        <header className={stylesModule.hero}>
          <div className={stylesModule.heroCopy}>
            <div className={stylesModule.kicker}>
              <strong>{data.workspace.name} / Founder view</strong>
              <span>Operational intelligence / 2026</span>
            </div>
            <div>
              <h1 className={stylesModule.heroTitle}>Control<br /><span>Center</span></h1>
              <p className={stylesModule.heroDescription}>
                Live health, queues, usage and project operations. A single operational view across Kit’s connected studio systems.
              </p>
            </div>
          </div>
          <div className={stylesModule.heroStatus}>
            <div className={stylesModule.heroStatusTop}>
              <span className={stylesModule.sectionLabel}>Live system state</span>
              <span className={`${stylesModule.statusMark} ${signalStyles[status.signal].text}`}><span className={stylesModule.statusDot} />Online</span>
            </div>
            <div className={stylesModule.heroStatusBody}>
              <StatusIcon size={24} className={`mb-5 ${signalStyles[status.signal].text}`} strokeWidth={1.5} aria-hidden="true" />
              <p className={stylesModule.statusHeadline}>{status.label}</p>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={isPending}
              className={stylesModule.refreshButton}
            >
              <span>Refresh live data</span>
              <RefreshCw size={15} className={isPending ? 'animate-spin' : ''} aria-hidden="true" />
            </button>
            <div className={stylesModule.refreshMeta}>
              Live check {timeAgo(data.checkedAt, clock)} / Auto 30s
              {error ? <div className={stylesModule.refreshError}>{error}</div> : null}
            </div>
          </div>
        </header>

        <section aria-label="Operational summary" className={stylesModule.summaryGrid}>
          <SummaryCard icon={HeartPulse} label="System health" value={data.overall === 'operational' ? 'Healthy' : data.overall === 'attention' ? 'Review' : 'Issue'} signal={status.signal} detail={`${data.integrations.filter((item) => item.ok).length}/${data.integrations.length} integrations up`} />
          <SummaryCard icon={TriangleAlert} label="Needs attention" value={data.summary.attentionCount} signal={data.summary.attentionCount ? (data.overall === 'incident' ? 'danger' : 'warning') : 'healthy'} detail={data.summary.attentionCount ? 'open items' : 'nothing waiting'} />
          <SummaryCard icon={FolderKanban} label="Active projects" value={data.summary.activeProjects} signal="neutral" detail="including on-hold work" />
          <SummaryCard icon={Workflow} label="Automations" value={`${data.summary.healthyAutomations}/${data.summary.totalAutomations}`} signal={data.summary.healthyAutomations === data.summary.totalAutomations ? 'healthy' : 'danger'} detail="fresh scheduled jobs" />
          <SummaryCard icon={CheckCircle2} label="Kit actions" value={data.summary.completedSevenDays} signal="neutral" detail="completed in 7 days" />
        </section>

        <div className={stylesModule.sectionGrid}>
          <Panel title="Needs attention" icon={TriangleAlert} eyebrow="Priority signal / 01" action={<span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#737b8c]">{data.attention.length} shown</span>}>
            {data.attention.length ? (
              <div className={stylesModule.dataList}>
                {data.attention.map((item) => {
                  const styles = signalStyles[item.signal]
                  const content = (
                    <div className={stylesModule.dataRow}>
                      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${styles.dot}`} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-[#f4f4f5]">{item.title}</p>
                        <p className="mt-1 text-sm leading-5 text-[#8e96a7]">{item.detail}</p>
                      </div>
                      {item.timestamp ? <span className="shrink-0 text-xs text-[#6f7787]">{timeAgo(item.timestamp, clock)}</span> : null}
                      {item.href ? <ArrowUpRight size={15} className="mt-1 shrink-0 text-[#7f8798]" aria-hidden="true" /> : null}
                    </div>
                  )
                  return item.href ? <Link key={item.id} href={item.href} className={stylesModule.dataRowLink}>{content}</Link> : <div key={item.id}>{content}</div>
                })}
              </div>
            ) : (
              <EmptyState icon={CheckCircle2} title="Nothing needs attention" detail="Kit’s monitored systems and queues are clear." />
            )}
          </Panel>

          <Panel title="Integrations" icon={CloudCog} eyebrow="Provider state / 02" action={<Link href="/status" className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[#00ff66] hover:text-[#8affb2]">Technical status <ExternalLink size={12} /></Link>}>
            <div className="space-y-2">
              {data.integrations.map((check) => <HealthRow key={check.key} check={check} />)}
              {!data.integrations.length ? <EmptyState icon={CloudCog} title="No checks available" detail="The live health probe did not return integration data." /> : null}
            </div>
          </Panel>
        </div>

        <div className={stylesModule.sectionGrid}>
          <Panel title="Automation reliability" icon={Activity} eyebrow="Seven-day telemetry / 03" action={<span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#737b8c]">Successful / failed</span>}>
            <ReliabilityChart data={data.reliability} />
            <div className="mt-6 grid gap-2 md:grid-cols-2">
              {data.automations.map((check) => <HealthRow key={check.key} check={check} compact />)}
            </div>
          </Panel>

          <Panel title="Active queues" icon={TimerReset} eyebrow="Durable workflow / 04">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              {data.queues.map((item) => <QueueCard key={item.key} item={item} now={clock} />)}
            </div>
          </Panel>
        </div>

        <div className={stylesModule.sectionGridWide}>
          <Panel title="Project health" icon={FolderKanban} eyebrow="Active work / 05" action={<Link href="/projects" className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[#00ff66] hover:text-[#8affb2]">All projects <ArrowUpRight size={12} /></Link>}>
            {data.projects.length ? (
              <div className={stylesModule.tableWrap}>
                <table className={stylesModule.table}>
                  <thead>
                    <tr>
                      <th className="pb-3 font-medium">Project</th>
                      <th className="pb-3 font-medium">Client</th>
                      <th className="pb-3 font-medium">Phase</th>
                      <th className="pb-3 font-medium">Status</th>
                      <th className="pb-3 text-right font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((project) => (
                      <tr key={project.id} className="group">
                        <td className="py-3 pr-4">
                          <Link href={`/control-center/projects/${project.id}`} className="flex items-center gap-3 font-medium text-white transition group-hover:text-[#00ff66]">
                            <span className={`h-2.5 w-2.5 rounded-full ${signalStyles[project.signal].dot}`} />
                            <span className="font-mono text-xs text-[#00ff66]">{project.code}</span>
                            <span className="truncate">{project.name}</span>
                          </Link>
                        </td>
                        <td className="py-3 pr-4 text-sm text-[#9ca3af]">{project.client}</td>
                        <td className="py-3 pr-4 text-sm text-[#9ca3af]">{project.phase || '—'}</td>
                        <td className="py-3 pr-4"><StatusPill signal={project.signal}>{titleCase(project.status)}</StatusPill></td>
                        <td className="py-3 text-right font-mono text-xs text-[#9ca3af]">{project.targetDelivery || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState icon={FolderKanban} title="No active projects" detail="Active projects will appear here as Kit provisions them." />}
          </Panel>

          <Panel title="Time logging" icon={Clock3} eyebrow="Harvest state / 06">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Logged today" value={data.timeLogging.loggedToday} />
              <Metric label="Last 7 days" value={`${data.timeLogging.hoursSevenDays}h`} />
              <Metric label="Awaiting reply" value={data.timeLogging.awaitingConfirmation} warning={data.timeLogging.awaitingConfirmation > 0} />
              <Metric label="Needs matching" value={data.timeLogging.needsClarification} warning={data.timeLogging.needsClarification > 0} />
            </div>
            <div className={`mt-4 border p-3 ${data.timeLogging.failed || data.timeLogging.stuck ? 'border-rose-400/20 bg-rose-400/10' : 'border-emerald-400/20 bg-emerald-400/10'}`}>
              <div className="flex items-center gap-2">
                {data.timeLogging.failed || data.timeLogging.stuck ? <XCircle size={16} className="text-rose-300" /> : <Check size={16} className="text-emerald-300" />}
                <span className="text-sm font-medium">{data.timeLogging.failed || data.timeLogging.stuck ? `${data.timeLogging.failed} failed · ${data.timeLogging.stuck} stuck` : 'No failed or stuck check-ins'}</span>
              </div>
            </div>
          </Panel>
        </div>

        <div className={stylesModule.sectionGridThree}>
          <Panel title="Dedicated workers" icon={ServerCog} eyebrow="Compute state / 07">
            <div className="space-y-3">
              {data.workers.map((worker) => (
                <div key={worker.id} className={stylesModule.subCard}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${signalStyles[worker.signal].dot}`} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{worker.label}</p>
                        <p className="text-xs text-[#777f90]">{worker.type} · {timeAgo(worker.lastSeenAt, clock)}</p>
                      </div>
                    </div>
                    <StatusPill signal={worker.signal}>{titleCase(worker.status)}</StatusPill>
                  </div>
                  {worker.detail ? <p className="mt-2 truncate text-xs text-[#8f97a7]">{worker.detail}</p> : null}
                </div>
              ))}
              {!data.workers.length ? <EmptyState icon={ServerCog} title="No workers registered" detail="Render and Behance workers will appear after their first heartbeat." /> : null}
            </div>
          </Panel>

          <Panel title="Privacy safeguards" icon={ShieldCheck} eyebrow="Safety boundary / 08">
            <div className="space-y-3">
              <Safeguard label="Plaud ingestion" ok={data.safeguards.plaudEnabled} detail={data.safeguards.plaudEnabled ? `${data.safeguards.transcriptCountSevenDays} transcripts ingested in 7 days` : 'Currently disabled'} />
              <Safeguard label="Shared transcript exposure" ok={data.safeguards.sharedTranscriptLeakCount === 0} detail={data.safeguards.sharedTranscriptLeakCount === 0 ? 'No team-surface leak flags detected' : `${data.safeguards.sharedTranscriptLeakCount} records need review`} />
              <Safeguard label="Service credentials" ok={data.safeguards.serviceRoleServerOnly} detail={data.safeguards.serviceRoleServerOnly ? 'Server-only; not exposed to the browser' : 'Public environment exposure detected'} />
            </div>
            <p className="mt-4 text-xs leading-5 text-[#777f90]">This panel reports safety state only. It never displays transcript text, private Slack messages, budgets or client contact details.</p>
          </Panel>

          <Panel title="Recent activity" icon={History} eyebrow="Audit trail / 09">
            <div className="max-h-[360px] space-y-4 overflow-y-auto pr-1">
              {data.recentActivity.map((item) => <ActivityRow key={item.id} item={item} now={clock} />)}
              {!data.recentActivity.length ? <EmptyState icon={History} title="No recent activity" detail="Completed Kit actions will appear here." /> : null}
            </div>
          </Panel>
        </div>

        <div className={stylesModule.sectionGrid}>
          <Panel title="Deployments & versions" icon={GitCommitHorizontal} eyebrow="Runtime state / 10">
            <div className="space-y-3">
              {data.releases.map((release) => (
                <div key={release.key} className={stylesModule.subCard}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${signalStyles[release.signal].dot}`} />
                      <div><p className="font-medium">{release.label}</p><p className="text-xs text-[#777f90]">{release.provider} · {release.environment}</p></div>
                    </div>
                    <span className="border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-xs text-[#00ff66]">{release.revision || 'unreported'}</span>
                  </div>
                  <p className="mt-2 break-all text-xs leading-5 text-[#8f97a7]">{release.detail}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Tracked API costs" icon={Coins} eyebrow="Measured spend / 11">
            <div className={`${stylesModule.subCard} mb-4 flex items-end justify-between`}>
              <div><p className="text-xs uppercase tracking-[0.12em] text-[#747c8d]">Known spend</p><p className="mt-1 font-mono text-3xl font-semibold">${(data.costs.trackedCentsThirtyDays / 100).toFixed(2)}</p></div>
              <p className="max-w-44 text-right text-xs leading-5 text-[#777f90]">Uninstrumented providers are excluded, never estimated.</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {data.costs.byProvider.map((provider) => <Metric key={provider.key} label={provider.label} value={`$${(provider.cents / 100).toFixed(2)}`} />)}
            </div>
            <div className="mt-4 space-y-2">
              {data.costs.coverage.map((item) => (
                <div key={item.label} className="flex items-start gap-2 text-xs">
                  {item.tracked ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />}
                  <p><span className="font-medium text-[#d7d9df]">{item.label}:</span> <span className="text-[#7f8798]">{item.detail}</span></p>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="mt-5">
        <Panel title="Usage" icon={Gauge} eyebrow="Seven-day volume / 12">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.usage.map((metric) => (
              <div key={metric.key} className={stylesModule.subCard}>
                <p className="text-xs uppercase tracking-[0.12em] text-[#747c8d]">{metric.label}</p>
                <p className="mt-2 font-mono text-2xl font-semibold text-white">{metric.value}{metric.suffix || ''}</p>
                <p className="mt-1 text-xs text-[#838b9b]">{metric.detail}</p>
              </div>
            ))}
          </div>
        </Panel>
        </div>

        <footer className={stylesModule.footer}>
          <span>Kit Control Center · generated {timeAgo(data.generatedAt, clock)}</span>
          <span>Projects: Google control sheet + Supabase · Operations: Supabase + live provider probes</span>
        </footer>
      </div>
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value, detail, signal }: { icon: typeof Bot; label: string; value: string | number; detail: string; signal: Signal }) {
  const styles = signalStyles[signal]
  return (
    <div className={stylesModule.summaryCard}>
      <div className={stylesModule.summaryTop}>
        <span>{label}</span>
        <Icon size={17} className={styles.text} aria-hidden="true" />
      </div>
      <span className={stylesModule.summaryValue}>{value}</span>
      <p className={stylesModule.summaryDetail}>{detail}</p>
    </div>
  )
}

function Panel({ title, eyebrow, icon: Icon, action, children }: { title: string; eyebrow: string; icon: typeof Bot; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={stylesModule.panel}>
      <div className={stylesModule.panelHeader}>
        <div className={stylesModule.panelIcon}><Icon size={19} strokeWidth={1.5} aria-hidden="true" /></div>
        <div className={stylesModule.panelTitleBlock}>
          <p className={stylesModule.eyebrow}>{eyebrow}</p>
          <h2 className={stylesModule.panelTitle}>{title}</h2>
        </div>
        {action ? <div className={stylesModule.panelAction}>{action}</div> : null}
      </div>
      <div className={stylesModule.panelBody}>{children}</div>
    </section>
  )
}

function HealthRow({ check, compact = false }: { check: HealthCheck; compact?: boolean }) {
  return (
    <div className={`${stylesModule.healthRow} ${compact ? stylesModule.healthRowCompact : ''}`}>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${check.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{check.label}</p>
        {check.detail ? <p className="truncate font-mono text-[11px] text-[#747c8d]">{check.detail}</p> : null}
      </div>
      <span className={`text-[11px] font-bold tracking-[0.08em] ${check.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{check.ok ? 'UP' : 'DOWN'}</span>
    </div>
  )
}

function QueueCard({ item, now }: { item: QueueSummary; now: number }) {
  const styles = signalStyles[item.signal]
  return (
    <div className={`${stylesModule.subCard} ${stylesModule.queueCard}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
          <span className="truncate text-sm font-medium">{item.label}</span>
        </div>
        <span className={`font-mono text-lg font-semibold ${item.count ? styles.text : 'text-[#667080]'}`}>{item.count}</span>
      </div>
      <p className="mt-1 text-xs text-[#71798a]">{item.count ? `Oldest ${timeAgo(item.oldestAt, now)}` : 'Queue clear'}</p>
    </div>
  )
}

function ReliabilityChart({ data }: { data: ControlCenterPayload['reliability'] }) {
  const max = Math.max(1, ...data.map((day) => day.successful + day.failed))
  return (
    <div className={stylesModule.chart} aria-label="Seven-day automation reliability chart">
      {data.map((day) => {
        const successHeight = Math.max(day.successful ? 8 : 0, (day.successful / max) * 100)
        const failedHeight = Math.max(day.failed ? 8 : 0, (day.failed / max) * 100)
        return (
          <div key={day.date} className="flex min-w-0 flex-col items-center justify-end gap-2">
            <div className={stylesModule.chartBar} title={`${day.successful} successful, ${day.failed} failed`}>
              <div className="w-full bg-emerald-400/80" style={{ height: `${successHeight}%` }} />
              <div className="w-full bg-rose-400/90" style={{ height: `${failedHeight}%` }} />
            </div>
            <span className="text-xs text-[#747c8d]">{day.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function StatusPill({ signal, children }: { signal: Signal; children: React.ReactNode }) {
  const styles = signalStyles[signal]
  return <span className={`${stylesModule.statusPill} ${styles.text} ${styles.bg}`}>{children}</span>
}

function Metric({ label, value, warning = false }: { label: string; value: string | number; warning?: boolean }) {
  return (
    <div className={stylesModule.metric}>
      <p className={stylesModule.metricLabel}>{label}</p>
      <p className={`${stylesModule.metricValue} ${warning ? 'text-amber-300' : 'text-white'}`}>{value}</p>
    </div>
  )
}

function Safeguard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className={`${stylesModule.subCard} flex items-start gap-3`}>
      {ok ? <ShieldCheck size={17} className="mt-0.5 shrink-0 text-emerald-300" /> : <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-300" />}
      <div><p className="text-sm font-medium">{label}</p><p className="mt-0.5 text-xs leading-5 text-[#7d8596]">{detail}</p></div>
    </div>
  )
}

function ActivityRow({ item, now }: { item: ActivityItem; now: number }) {
  const content = (
    <div className="flex gap-3">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${signalStyles[item.signal].dot}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-[#7e8696]">{item.detail}</p>
      </div>
      <span className="shrink-0 text-[11px] text-[#697183]">{timeAgo(item.at, now)}</span>
      {item.href ? <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-[#7f8798]" aria-hidden="true" /> : null}
    </div>
  )
  return item.href
    ? <a href={item.href} target="_blank" rel="noreferrer" className="block">{content}</a>
    : content
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof Bot; title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center border border-dashed border-white/10 px-5 py-8 text-center">
      <Icon size={22} className="text-[#697183]" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-[#727a8b]">{detail}</p>
    </div>
  )
}
