'use client'

import { useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'

export function ProjectActions({ projectId, projectCode, canReconcile, retryableBehanceJobId }: { projectId: string; projectCode: string; canReconcile: boolean; retryableBehanceJobId: string | null }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const run = async (action: 'reconcile_project' | 'retry_behance', jobId?: string) => {
    const label = action === 'reconcile_project' ? `reconcile ${projectCode}'s three Slack Canvases from the Google Sheet` : `retry ${projectCode}'s private Behance draft`
    if (!window.confirm(`Ask Kit to ${label}?`)) return
    setBusy(action); setMessage(null)
    try {
      const response = await fetch('/api/control-center/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, projectId, ...(jobId ? { jobId } : {}) }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Action failed.')
      setMessage(action === 'reconcile_project' ? 'Reconcile queued. The Canvases will refresh shortly.' : 'Behance retry queued on the studio Mac.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Action failed.') } finally { setBusy(null) }
  }
  return <div className="flex flex-wrap items-center gap-2">
    {canReconcile ? <button type="button" disabled={busy !== null} onClick={() => void run('reconcile_project')} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 py-2 text-sm hover:bg-white/[.08] disabled:opacity-50"><RefreshCw size={14} className={busy === 'reconcile_project' ? 'animate-spin' : ''} /> Reconcile Canvases</button> : null}
    {retryableBehanceJobId ? <button type="button" disabled={busy !== null} onClick={() => void run('retry_behance', retryableBehanceJobId)} className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-200 hover:bg-amber-400/15 disabled:opacity-50"><RotateCcw size={14} className={busy === 'retry_behance' ? 'animate-spin' : ''} /> Retry Behance</button> : null}
    {message ? <span role="status" className="basis-full text-right text-xs text-[#9ca3af]">{message}</span> : null}
  </div>
}
