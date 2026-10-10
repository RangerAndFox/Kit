import { randomUUID } from 'node:crypto'
import { createAdminClient } from '../supabase/admin'
import { assetSources, digest, renderFeedback, sectionMarker, type FeedbackSnapshot, type FeedbackSource } from './model'
import { FeedbackError, readFeedback, errorMessage } from './providers'
import { publishSection } from './canvas'
import type { Json } from '../../types/supabase'

export function feedbackEnabled() { return process.env.PROJECT_FEEDBACK_SYNC_ENABLED === 'true' }
export async function registerFeedbackSources(projectId: string, links: Array<Record<string,string>>) {
  const { error } = await createAdminClient().rpc('register_project_feedback', { p_project: projectId, p_sources: assetSources(links) as unknown as Json })
  if (error) throw new Error('feedback_source_registration_failed')
}
export interface FeedbackRow {
  id: string; project_id: string; source: FeedbackSource; active: boolean; snapshot: FeedbackSnapshot | null;
  heading_hash: string | null; body_hash: string | null
}
export interface FeedbackPorts {
  read(source: FeedbackSource): Promise<FeedbackSnapshot>;
  publish: typeof publishSection;
  assertOwned(): Promise<void>;
  finish(snapshot: FeedbackSnapshot | null, heading: string | null, body: string | null, error: string | null, delay: number): Promise<void>;
}
export async function syncFeedbackRow(row: FeedbackRow, canvasId: string, ports: FeedbackPorts) {
  let snapshot = row.snapshot, problem: string | undefined, error: string | null = null, delay = 3600
  if (row.active) {
    try { snapshot = await ports.read(row.source) }
    catch (e) {
      error = e instanceof FeedbackError ? e.code : 'feedback_read_failed'
      delay = e instanceof FeedbackError ? e.retryAfterSeconds : 3600
      problem = errorMessage(error)
    }
  } else { snapshot = null; problem = 'This file is no longer tracked in project Assets. Existing team notes were preserved.'; delay = 2678400 }
  const rendered = renderFeedback(row.source, snapshot, problem)
  const heading = digest(rendered.heading), body = digest(rendered.table)
  try {
    await ports.publish({ canvasId, marker: sectionMarker(row.source.key), type: 'h3', markdown: rendered.heading,
      changed: heading !== row.heading_hash, assertOwned: ports.assertOwned })
    await ports.publish({ canvasId, marker: sectionMarker(row.source.key), type: 'table', markdown: rendered.table,
      changed: body !== row.body_hash, assertOwned: ports.assertOwned })
    await ports.finish(snapshot, heading, body, error, delay)
  } catch {
    // An ambiguous Slack response must never checkpoint publication. The next
    // attempt first looks up both markers, recovering a post-before-save crash.
    await ports.finish(snapshot, row.heading_hash, row.body_hash, 'feedback_canvas_sync_failed', 3600)
    throw new Error('feedback_canvas_sync_failed')
  }
  return { error }
}

export async function syncStoredFeedback(id: string) {
  const db = createAdminClient(), token = randomUUID()
  const claim = await db.rpc('claim_project_feedback', { p_id: id, p_token: token })
  if (claim.error) throw new Error('feedback_claim_failed')
  if (!claim.data) return { skipped: true }
  const loaded = await db.from('project_feedback_sources').select('*').eq('id', id).eq('lease_token', token).single()
  if (loaded.error) throw new Error('feedback_read_failed')
  const row = loaded.data as unknown as FeedbackRow
  const canvas = await db.from('project_control_canvases').select('canvas_id').eq('project_id', row.project_id).eq('canvas_type','notesAndFeedback').single()
  const finish: FeedbackPorts['finish'] = async (snapshot, heading, body, error, delay) => {
    const result = await db.rpc('finish_project_feedback', { p_id: id, p_token: token, p_snapshot: snapshot as unknown as Json,
      p_heading: heading, p_body: body, p_error: error, p_delay: delay })
    if (result.error || !result.data) throw new Error('feedback_checkpoint_failed')
  }
  if (canvas.error || !canvas.data?.canvas_id) {
    await finish(row.snapshot, row.heading_hash, row.body_hash, 'feedback_canvas_missing', 3600)
    return { error: 'feedback_canvas_missing' }
  }
  return syncFeedbackRow(row, canvas.data.canvas_id, {
    read: readFeedback, publish: publishSection, finish,
    assertOwned: async () => {
      const own = await db.from('project_feedback_sources').select('id').eq('id', id).eq('lease_token', token)
        .gt('lease_expires_at', new Date(Date.now() + 60_000).toISOString()).maybeSingle()
      if (own.error || !own.data) throw new Error('feedback_lease_lost')
    },
  })
}
