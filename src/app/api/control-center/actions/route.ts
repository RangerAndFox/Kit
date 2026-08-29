/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { createAdminClient } from '@/lib/supabase/admin'
import { inngest } from '@/lib/inngest/client'
import { queueBehanceDraft } from '@/lib/archive/behance-store'

export const runtime = 'nodejs'

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reconcile_project'), projectId: z.string().uuid() }),
  z.object({ action: z.literal('retry_behance'), projectId: z.string().uuid(), jobId: z.string().uuid() }),
])

export async function POST(request: NextRequest) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return NextResponse.json({ error: 'Request denied.' }, { status: 403 })
  const access = await getControlCenterAccess()
  if (!access) return NextResponse.json({ error: 'Founder access required.' }, { status: 403 })
  const parsed = Input.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action.' }, { status: 400 })
  const db = createAdminClient() as any
  const { data: project } = await db.from('projects').select('id,project_code').eq('workspace_id', access.workspaceId).eq('id', parsed.data.projectId).maybeSingle()
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
  const requestId = randomUUID()
  try {
    if (parsed.data.action === 'reconcile_project') {
      const { data: binding, error } = await db.from('project_control_bindings').select('spreadsheet_id,sheet_id').eq('project_id', project.id).maybeSingle()
      if (error || !binding) throw new Error(error?.message || 'This project has no control-sheet binding.')
      const updates = await Promise.all([
        db.from('project_control_bindings').update({ sync_status: 'pending', error: null, updated_at: new Date().toISOString() }).eq('project_id', project.id),
        db.from('project_control_canvases').update({ sync_status: 'pending', error: null, updated_at: new Date().toISOString() }).eq('project_id', project.id),
      ])
      const updateError = updates.find((result) => result.error)?.error
      if (updateError) throw new Error(updateError.message)
      await inngest.send({ name: 'project-control/sheet.edited', id: requestId, data: { spreadsheet_id: binding.spreadsheet_id, sheet_id: Number(binding.sheet_id), request_id: requestId, ts: Date.now() } })
    } else {
      const { data: job } = await db.from('behance_draft_jobs').select('id,archive_job_id,status').eq('workspace_id', access.workspaceId).eq('project_id', project.id).eq('id', parsed.data.jobId).maybeSingle()
      if (!job || !['failed', 'retryable'].includes(job.status)) throw new Error('This Behance draft is no longer retryable.')
      await queueBehanceDraft(job.archive_job_id, `control-center:${access.userId}`)
    }
    await db.from('kit_actions').insert({
      workspace_id: access.workspaceId, project_id: project.id, action_type: `control_center:${parsed.data.action}`,
      title: `${project.project_code || 'Project'} ${parsed.data.action === 'reconcile_project' ? 'Canvas reconcile requested' : 'Behance retry requested'}`,
      description: 'Founder-initiated action from the Kit Control Center.', priority: 'medium', status: 'auto_completed', resolved_at: new Date().toISOString(),
      metadata: { request_id: requestId, initiated_by: access.userId },
    })
    return NextResponse.json({ ok: true, requestId })
  } catch (error) {
    console.error('[control-center action]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Action failed.' }, { status: 409 })
  }
}
