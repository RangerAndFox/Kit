import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const maxDuration = 30
const now = () => new Date().toISOString()

export function isStudioWorkerAuthorized(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.KIT_STUDIO_WORKER_SECRET || ''
  const supplied = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return expected.length >= 32 && supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}

const browserStatuses = new Set(['idle', 'working', 'needs_login', 'error'])
const behanceJobStatuses = new Set(['opening_editor', 'uploading_media', 'filling_details', 'saving_draft', 'awaiting_review', 'retryable', 'failed', 'cancelled'])
const elevenJobStatuses = new Set(['opening_studio', 'filling_project', 'saving_draft', 'complete', 'retryable', 'failed', 'cancelled'])
const renderPatchKeys = new Set([
  'status', 'progress_percent', 'progress_message', 'error_message', 'ffmpeg_command',
  'aerender_command', 'output_path', 'output_filename', 'output_size_bytes',
  'duration_seconds', 'qc_checklist_status', 'processing_started_at', 'completed_at',
  'render_queue', 'total_frames', 'chunk_count',
])
const renderInsertKeys = new Set([
  'job_type', 'status', 'parent_job_id', 'chunk_index', 'frame_start', 'frame_end',
  'total_frames', 'frame_rate', 'requested_by', 'slack_channel', 'slack_thread_ts',
  'source_files', 'ae_project_path', 'ae_comp', 'ae_rqindex', 'ae_is_movie',
  'ae_output_dir', 'ae_output_pattern', 'delivery_profile_id', 'profile_snapshot',
  'output_filename', 'ae_render_settings_template', 'ae_output_module_template',
])
const pick = (value: any, keys: Set<string>) => Object.fromEntries(
  Object.entries(value || {}).filter(([key]) => keys.has(key)),
)

export async function POST(request: Request) {
  if (!isStudioWorkerAuthorized(request)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body.action !== 'string' || !body.workerId) {
    return NextResponse.json({ ok: false, error: 'invalid request' }, { status: 400 })
  }
  const sb = createAdminClient() as any
  const workerId = String(body.workerId).slice(0, 200)
  const displayName = String(body.displayName || workerId).slice(0, 200)

  try {
    if (body.action === 'behance.heartbeat' || body.action === 'elevenlabs.heartbeat') {
      if (!browserStatuses.has(body.status)) throw new Error('invalid worker status')
      const table = body.action.startsWith('behance') ? 'behance_workers' : 'elevenlabs_workers'
      const { error } = await sb.from(table).upsert({
        worker_id: workerId,
        display_name: displayName,
        status: body.status,
        current_job_id: body.jobId || null,
        last_error: body.error ? String(body.error).slice(0, 1000) : null,
        ...(body.browserVersion ? { browser_version: String(body.browserVersion).slice(0, 200) } : {}),
        last_seen_at: now(),
        updated_at: now(),
      }, { onConflict: 'worker_id' })
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'behance.claim' || body.action === 'elevenlabs.claim') {
      const isBehance = body.action.startsWith('behance')
      const table = isBehance ? 'behance_draft_jobs' : 'elevenlabs_studio_jobs'
      const active = isBehance
        ? ['claimed', 'opening_editor', 'uploading_media', 'filling_details', 'saving_draft']
        : ['claimed', 'opening_studio', 'filling_project', 'saving_draft']
      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString()
      await sb.from(table).update({
        status: 'retryable', claimed_by: null, claimed_at: null,
        error: 'Worker heartbeat expired; queued for recovery.', updated_at: now(),
      }).in('status', active).lt('heartbeat_at', staleBefore)
      const { data: candidates, error: readError } = await sb.from(table)
        .select('id,attempt').in('status', ['queued', 'retryable']).order('created_at', { ascending: true }).limit(1)
      if (readError) throw readError
      if (!candidates?.length) return NextResponse.json({ ok: true, job: null })
      const claimedAt = now()
      const { data, error } = await sb.from(table).update({
        status: 'claimed', claimed_by: workerId, claimed_at: claimedAt, heartbeat_at: claimedAt,
        attempt: Number(candidates[0].attempt || 0) + 1,
        started_at: now(), completed_at: null, error: null, updated_at: now(),
      }).eq('id', candidates[0].id).in('status', ['queued', 'retryable']).select('*').maybeSingle()
      if (error) throw error
      return NextResponse.json({ ok: true, job: data || null })
    }

    if (body.action === 'behance.update' || body.action === 'elevenlabs.update' || body.action === 'behance.pulse' || body.action === 'elevenlabs.pulse') {
      const isBehance = body.action.startsWith('behance')
      const table = isBehance ? 'behance_draft_jobs' : 'elevenlabs_studio_jobs'
      const isPulse = body.action.endsWith('pulse')
      const statusSet = isBehance ? behanceJobStatuses : elevenJobStatuses
      if (!isPulse && !statusSet.has(body.status)) throw new Error('invalid job status')
      const terminal = !isPulse && (isBehance
        ? ['awaiting_review', 'failed', 'cancelled'].includes(body.status)
        : ['complete', 'failed', 'cancelled'].includes(body.status))
      const safePatch: Record<string, unknown> = {}
      if (body.patch?.error !== undefined) safePatch.error = body.patch.error ? String(body.patch.error).slice(0, 2000) : null
      if (isBehance) {
        for (const key of ['draft_url', 'proof_dropbox_path', 'proof_url']) {
          if (body.patch?.[key] !== undefined) safePatch[key] = body.patch[key] ? String(body.patch[key]).slice(0, 2000) : null
        }
      }
      const patch = {
        ...(!isPulse ? { status: body.status } : {}),
        heartbeat_at: now(), updated_at: now(),
        ...(terminal ? { completed_at: now() } : {}), ...safePatch,
      }
      const { data, error } = await sb.from(table).update(patch)
        .eq('id', body.jobId).eq('claimed_by', workerId).eq('claimed_at', body.claimedAt).select('id')
      if (error) throw error
      if (!data?.length) return NextResponse.json({ ok: false, error: 'claim lost' }, { status: 409 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'elevenlabs.complete') {
      const { data, error } = await sb.rpc('complete_elevenlabs_studio_job', {
        p_job_id: body.jobId, p_worker_id: workerId, p_claimed_at: body.claimedAt,
        p_project_id: body.projectId, p_url: body.url,
      })
      if (error) throw error
      if (!data) return NextResponse.json({ ok: false, error: 'claim lost' }, { status: 409 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'elevenlabs.fail_storyboard') {
      const { error } = await sb.from('storyboard_jobs').update({
        elevenlabs_status: 'failed',
        elevenlabs_error: String(body.error || 'Unknown worker failure').slice(0, 1000),
        updated_at: now(),
      }).eq('id', body.storyboardJobId)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'render.heartbeat') {
      const heartbeat = pick(body.heartbeat, new Set([
        'display_name', 'role', 'priority', 'status', 'cpu_usage_percent',
        'memory_usage_percent', 'disk_free_gb', 'current_job_id', 'max_concurrent_jobs',
        'cpu_threshold', 'dropbox_sync_path', 'ffmpeg_path', 'os_version',
        'ae_capable', 'aerender_path', 'ae_version',
      ]))
      const { error } = await sb.from('render_workers').upsert({
        hostname: workerId, ...heartbeat, last_heartbeat: now(),
      }, { onConflict: 'hostname' })
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'render.claim') {
      const claimable = body.aeCapable
        ? ['transcode', 'ae_inspect', 'ae_chunk', 'ae_stitch']
        : ['transcode', 'ae_stitch']
      let query = sb.from('render_jobs').select('id').eq('status', 'pending')
        .in('job_type', claimable).order('created_at', { ascending: true }).limit(1)
      if (body.ageThresholdIso) query = query.lt('created_at', body.ageThresholdIso)
      const { data: candidates, error: readError } = await query
      if (readError) throw readError
      if (!candidates?.length) return NextResponse.json({ ok: true, job: null })
      const claimedAt = now()
      const { data, error } = await sb.from('render_jobs').update({
        status: 'claimed', claimed_by: workerId, claimed_at: claimedAt, updated_at: now(),
      }).eq('id', candidates[0].id).eq('status', 'pending').select('*').maybeSingle()
      if (error) throw error
      return NextResponse.json({ ok: true, job: data || null })
    }

    if (body.action === 'render.owned_update') {
      const { data, error } = await sb.from('render_jobs').update({
        ...pick(body.patch, renderPatchKeys), updated_at: now(),
      }).eq('id', body.jobId).eq('claimed_by', workerId).eq('claimed_at', body.claimedAt).select('id')
      if (error) throw error
      return NextResponse.json({ ok: true, updated: (data?.length || 0) > 0 })
    }

    if (body.action === 'render.parent_update') {
      const { error } = await sb.from('render_jobs').update({
        ...pick(body.patch, renderPatchKeys), updated_at: now(),
      }).eq('id', body.jobId).eq('job_type', 'ae_render')
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'render.ae_worker_count') {
      const { count, error } = await sb.from('render_workers').select('hostname', { count: 'exact', head: true })
        .eq('ae_capable', true).eq('status', 'online')
      if (error) throw error
      return NextResponse.json({ ok: true, count: count || 0 })
    }

    if (body.action === 'render.insert_jobs') {
      const rows = (Array.isArray(body.rows) ? body.rows : [body.row]).filter(Boolean)
        .slice(0, 100).map((row: any) => pick(row, renderInsertKeys))
      if (!rows.length || rows.some((row: any) => !row.job_type)) throw new Error('invalid render jobs')
      const { error } = await sb.from('render_jobs').insert(rows)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'render.list_chunks') {
      const { data, error } = await sb.from('render_jobs').select('id,status,frame_start')
        .eq('parent_job_id', body.parentId).eq('job_type', 'ae_chunk')
      if (error) throw error
      return NextResponse.json({ ok: true, chunks: data || [] })
    }

    if (body.action === 'render.claim_finalize') {
      const sentinel = `finalizer:${workerId}`
      const { data, error } = await sb.from('render_jobs').update({ claimed_by: sentinel, updated_at: now() })
        .eq('id', body.parentId).eq('job_type', 'ae_render').is('claimed_by', null).select('id').maybeSingle()
      if (error) throw error
      return NextResponse.json({ ok: true, won: !!data })
    }

    if (body.action === 'render.get_job') {
      const { data, error } = await sb.from('render_jobs').select('*').eq('id', body.jobId).maybeSingle()
      if (error) throw error
      return NextResponse.json({ ok: true, job: data || null })
    }

    if (body.action === 'render.fail_parent') {
      const { error } = await sb.from('render_jobs').update({
        status: 'failed', claimed_by: `finalizer:${workerId}`,
        error_message: String(body.error || 'Render chunk failed').slice(0, 2000), updated_at: now(),
      }).eq('id', body.parentId).eq('job_type', 'ae_render').is('claimed_by', null)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 })
  } catch (error: any) {
    console.error('[studio-worker-api]', body.action, error?.message || error)
    return NextResponse.json({ ok: false, error: 'operation failed' }, { status: 500 })
  }
}
