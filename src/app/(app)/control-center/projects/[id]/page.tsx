import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, ArrowUpRight, CalendarDays, CheckCircle2, CircleDot, ExternalLink, FileText, History, Link2, PanelsTopLeft } from 'lucide-react'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { loadControlCenterProject } from '@/lib/control-center/project-data'
import { ProjectActions } from './project-actions'

export const dynamic = 'force-dynamic'

const date = (value: string | null) => value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'America/Detroit' }).format(new Date(`${value.slice(0, 10)}T12:00:00-04:00`)) : '—'
const title = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const tone = (status: string) => /error|failed|orphan/i.test(status) ? 'text-rose-300 bg-rose-400/10 border-rose-400/20' : /pending|hold|retry|progress|queued/i.test(status) ? 'text-amber-300 bg-amber-400/10 border-amber-400/20' : 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20'

export default async function ControlCenterProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getControlCenterAccess()
  if (!access) redirect('/projects')
  const { id } = await params
  const data = await loadControlCenterProject(access.workspaceId, id)
  if (!data) notFound()
  const p = data.project
  return (
    <div className="min-h-screen bg-[#0c0e12] text-white">
      <div className="mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        <header className="border-b border-white/10 pb-6">
          <Link href="/control-center" className="mb-5 inline-flex items-center gap-2 text-sm text-indigo-300 hover:text-indigo-200"><ArrowLeft size={15} /> Control Center</Link>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div><p className="font-mono text-sm text-indigo-300">{p.code}</p><h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{p.name}</h1><p className="mt-2 text-[#9098a8]">{p.client} · {p.projectType || 'Project'}</p></div>
            <div className="flex flex-wrap items-center gap-3"><span className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${tone(p.status)}`}>{title(p.status)}</span><ProjectActions projectId={p.id} projectCode={p.code} canReconcile={data.actions.canReconcile} retryableBehanceJobId={data.actions.retryableBehanceJobId} /></div>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Start" value={date(p.startDate)} /><Stat label="Target delivery" value={date(p.targetDelivery)} />
          <Stat label="Budget" value={p.budgetTotal == null ? 'Not entered' : `$${p.budgetTotal.toLocaleString()}`} />
          <Stat label="Recorded spend" value={p.budgetSpent == null ? 'Not entered' : `$${p.budgetSpent.toLocaleString()}`} />
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
          <Panel title="Milestones" icon={CalendarDays} detail="Live project workback">
            <div className="space-y-2">{data.milestones.map((item) => <div key={item.id} className="flex items-center gap-3 rounded-lg border border-white/[.07] bg-black/10 p-3"><CircleDot size={15} className={/complete/i.test(item.status) ? 'text-emerald-300' : /progress/i.test(item.status) ? 'text-amber-300' : 'text-[#667080]'} /><div className="min-w-0 flex-1"><p className={/complete/i.test(item.status) ? 'text-[#7f8794] line-through' : 'font-medium'}>{item.name}</p><p className="text-xs text-[#71798a]">{date(item.dueDate)}</p></div><span className={`rounded-full border px-2 py-1 text-[11px] ${tone(item.status)}`}>{title(item.status)}</span></div>)}{!data.milestones.length ? <Empty text="No milestones are recorded for this project." /> : null}</div>
          </Panel>
          <Panel title="Canvas projections" icon={PanelsTopLeft} detail="Google Sheet → Slack">
            <div className="space-y-2">{data.canvases.map((canvas) => <div key={canvas.id} className="rounded-lg border border-white/[.07] bg-black/10 p-3"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${/synced/i.test(canvas.status) ? 'bg-emerald-400' : /error|orphan/i.test(canvas.status) ? 'bg-rose-400' : 'bg-amber-400'}`} /><span className="font-medium">{p.code}_{title(canvas.type)}</span></div>{canvas.url ? <a href={canvas.url} target="_blank" rel="noreferrer" className="text-indigo-300"><ArrowUpRight size={15} /></a> : null}</div><p className="mt-1 text-xs text-[#747c8d]">{title(canvas.status)} · last sync {canvas.lastSyncedAt ? new Date(canvas.lastSyncedAt).toLocaleString() : 'never'}</p>{canvas.error ? <p className="mt-2 text-xs text-rose-300">{canvas.error}</p> : null}</div>)}{!data.canvases.length ? <Empty text="No Canvas bindings exist yet." /> : null}</div>
          </Panel>
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <Panel title="Project links" icon={Link2} detail="Authoritative connected destinations"><div className="space-y-2">{p.links.map((item) => <a key={`${item.label}:${item.url}`} href={item.url} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-white/[.07] bg-black/10 p-3 text-sm hover:border-indigo-400/30"><span>{title(item.label)}</span><ExternalLink size={14} className="text-indigo-300" /></a>)}{!p.links.length ? <Empty text="No project links are stored yet." /> : null}</div></Panel>
          <Panel title="Recent shares" icon={FileText} detail="Dropbox → Frame.io progression"><div className="space-y-2">{data.shares.map((share) => <a key={share.id} href={share.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-white/[.07] bg-black/10 p-3 hover:border-indigo-400/30"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-medium">{share.fileName}</p><span className={`rounded-full border px-2 py-1 text-[11px] ${tone(share.status)}`}>{title(share.status)}</span></div><p className="mt-1 text-xs text-[#71798a]">{new Date(share.createdAt).toLocaleString()}</p></a>)}{!data.shares.length ? <Empty text="No Frame.io share events recorded." /> : null}</div></Panel>
          <Panel title="Operations" icon={History} detail="Safe workflow audit"><div className="space-y-3">{data.operations.map((item) => <div key={item.id} className="border-b border-white/[.07] pb-3 last:border-0 last:pb-0"><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{item.type}</p><span className={`rounded-full border px-2 py-1 text-[11px] ${tone(item.status)}`}>{title(item.status)}</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-[#777f90]">{item.detail}</p></div>)}{!data.operations.length ? <Empty text="No recent operations recorded." /> : null}</div></Panel>
        </div>

        {p.brief ? <Panel title="Project brief" icon={CheckCircle2} detail="Founder-only project context"><p className="whitespace-pre-wrap text-sm leading-7 text-[#a4abba]">{p.brief}</p></Panel> : null}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-white/[.08] bg-[#151820] p-4"><p className="text-xs uppercase tracking-[.12em] text-[#747c8d]">{label}</p><p className="mt-2 font-mono text-lg font-semibold">{value}</p></div> }
function Panel({ title, detail, icon: Icon, children }: { title: string; detail: string; icon: typeof CalendarDays; children: React.ReactNode }) { return <section className="rounded-xl border border-white/[.08] bg-[#151820] p-4 sm:p-5"><div className="mb-5 flex items-start gap-3"><div className="rounded-lg border border-white/[.08] bg-white/[.04] p-2 text-indigo-300"><Icon size={17} /></div><div><h2 className="font-semibold">{title}</h2><p className="text-xs text-[#747c8d]">{detail}</p></div></div>{children}</section> }
function Empty({ text }: { text: string }) { return <p className="rounded-lg border border-dashed border-white/10 p-5 text-center text-sm text-[#71798a]">{text}</p> }
