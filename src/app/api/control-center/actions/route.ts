/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
const MAX_ACTION_BYTES = 16 * 1024

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reconcile_project'), projectId: z.string().uuid() }),
  z.object({ action: z.literal('retry_behance'), projectId: z.string().uuid(), jobId: z.string().uuid() }),
])

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')
  if (!origin || origin !== new URL(request.url).origin) return NextResponse.json({ error: 'Request denied.' }, { status: 403 })
  const access = await getControlCenterAccess()
  if (!access) return NextResponse.json({ error: 'Founder access required.' }, { status: 403 })
  const declaredLength = Number(request.headers.get('content-length') || '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACTION_BYTES) return NextResponse.json({ error: 'Request too large.' }, { status: 413 })
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_ACTION_BYTES) return NextResponse.json({ error: 'Request too large.' }, { status: 413 })
  const parsed = Input.safeParse((() => { try { return JSON.parse(rawBody) } catch { return null } })())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action.' }, { status: 400 })
  const db = createAdminClient() as any
  const { data: project } = await db.from('projects').select('id,project_code').eq('workspace_id', access.workspaceId).eq('id', parsed.data.projectId).maybeSingle()
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
  const requestId = randomUUID()
  try {
    if (parsed.data.action === 'reconcile_project') {
      const { data: binding, error } = await db.from('project_control_bindings').select('spreadsheet_id,sheet_id').eq('project_id', project.id).maybeSingle()
      if (error || !binding) throw new Error(error?.message || 'This project has no control-sheet binding.')
    } else {
      const { data: job } = await db.from('behance_draft_jobs').select('id,archive_job_id,status').eq('workspace_id', access.workspaceId).eq('project_id', project.id).eq('id', parsed.data.jobId).maybeSingle()
      if (!job || !['failed', 'retryable'].includes(job.status)) throw new Error('This Behance draft is no longer retryable.')
    }
    const { data: queued, error: queueError } = await db.rpc('enqueue_control_action', {
      p_id: requestId, p_workspace_id: access.workspaceId, p_project_id: project.id,
      p_action: parsed.data.action, p_actor: access.userId,
      p_job_id: parsed.data.action === 'retry_behance' ? parsed.data.jobId : null,
    })
    if (queueError || queued !== requestId) throw new Error('Durable queue write failed')
    return NextResponse.json({ ok: true, requestId, status: 'queued' }, { status: 202 })
  } catch {
    console.error('[control-center action] durable request not accepted')
    return NextResponse.json({ error: 'Action could not be queued.' }, { status: 409 })
  }
}
