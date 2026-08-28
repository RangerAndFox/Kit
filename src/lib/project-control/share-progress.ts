import { createAdminClient } from '@/lib/supabase/admin'
import { workbookConfigFromEnv } from './types'
import { advanceWorkbackForShare, readProjectSupplement, recordLatestShare } from './sheets'
import { matchMilestone } from './workback'
import { requestProjectControlSync } from './sync-request'

// These tables are introduced by the accompanying migration and are not yet in
// the checked-in generated Database type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createAdminClient() as any

type ShareConfidence = 'exact' | 'probable' | 'uncertain'

type ProjectShareEvent = {
  id: string
  project_id: string
  file_name: string
  share_url: string
  suggested_milestone: string | null
  match_confidence: ShareConfidence | null
  slack_message_ts?: string | null
}

export type RegisteredProjectShare = {
  eventId: string | null
  milestone: string | null
  confidence: ShareConfidence
}

/** Complete the Sheet half of a durable share event. The event is inserted
 * before this runs, so a transient Google failure leaves recoverable state
 * instead of losing the Frame.io share forever. An empty milestone string is
 * the durable "sync succeeded, no confident match" sentinel; null means the
 * Sheet work still needs to be retried. */
export async function syncProjectShareEvent(eventId: string): Promise<RegisteredProjectShare> {
  const { data: event, error: eventError } = await db().from('project_share_events')
    .select('id,project_id,file_name,share_url,suggested_milestone,match_confidence,slack_message_ts')
    .eq('id', eventId).maybeSingle()
  if (eventError || !event) throw new Error(eventError?.message || `Project share event not found: ${eventId}`)
  const typed = event as ProjectShareEvent
  if (typed.suggested_milestone !== null) {
    return {
      eventId: typed.slack_message_ts ? null : typed.id,
      milestone: typed.suggested_milestone || null,
      confidence: typed.match_confidence || 'uncertain',
    }
  }

  const { data: project, error: projectError } = await db().from('projects')
    .select('id,project_code,external_ids').eq('id', typed.project_id).maybeSingle()
  if (projectError || !project) throw new Error(projectError?.message || `Project not found: ${typed.project_id}`)
  const projectNumber = project.external_ids?.project_number || String(project.project_code || '').split('-')[0]
  if (!projectNumber) throw new Error(`Project ${typed.project_id} has no project number`)

  const config = workbookConfigFromEnv()
  if (!config) throw new Error('Project Control workbook is not configured')
  const extra = await readProjectSupplement(config, projectNumber)
  const match = matchMilestone(typed.file_name, extra.workback.map((w) => w.Task))
  await recordLatestShare(config, typed.project_id, {
    label: typed.file_name,
    url: typed.share_url,
    date: new Date().toISOString().slice(0, 10),
    milestone: match.task,
  })
  if (!(await requestProjectControlSync(config, config.sheetId))) {
    console.warn('[project-control] immediate Latest Share refresh unavailable; cron will reconcile')
  }

  const { data: updated, error: updateError } = await db().from('project_share_events')
    .update({
      suggested_milestone: match.task || '',
      match_confidence: match.confidence,
      updated_at: new Date().toISOString(),
    })
    .eq('id', typed.id)
    .is('suggested_milestone', null)
    .select('id,suggested_milestone,match_confidence,slack_message_ts')
    .maybeSingle()
  if (updateError) throw new Error(`syncProjectShareEvent: ${updateError.message}`)
  const settled = (updated || typed) as ProjectShareEvent
  return {
    eventId: settled.slack_message_ts ? null : typed.id,
    milestone: updated ? (updated.suggested_milestone || null) : match.task,
    confidence: updated?.match_confidence || match.confidence,
  }
}

export async function registerProjectShare(input: {
  projectId: string
  projectNumber: string
  dropboxFileId: string
  dropboxRev: string
  fileName: string
  shareUrl: string
}): Promise<RegisteredProjectShare> {
  // Persist the outbox record FIRST. Previously the Google write happened
  // before this insert, so a transient 503 left no event for a retry sweep.
  const { data, error } = await db().from('project_share_events').upsert({
    project_id: input.projectId, dropbox_file_id: input.dropboxFileId, dropbox_rev: input.dropboxRev,
    file_name: input.fileName, share_url: input.shareUrl, suggested_milestone: null,
    match_confidence: null, status: 'pending', updated_at: new Date().toISOString(),
  }, { onConflict: 'project_id,dropbox_file_id,dropbox_rev', ignoreDuplicates: true }).select('id').maybeSingle()
  if (error) throw new Error(`registerProjectShare: ${error.message}`)
  let eventId = data?.id as string | undefined
  if (!eventId) {
    const { data: existing, error: existingError } = await db().from('project_share_events')
      .select('id').eq('project_id', input.projectId).eq('dropbox_file_id', input.dropboxFileId)
      .eq('dropbox_rev', input.dropboxRev).maybeSingle()
    if (existingError || !existing) throw new Error(existingError?.message || 'Existing project share event not found')
    eventId = existing.id
  }
  if (!eventId) throw new Error('Project share event id was not returned')
  return syncProjectShareEvent(eventId)
}

export async function applyProjectShare(eventId: string, slackUserId: string): Promise<{ projectName: string; milestone: string; nextMilestone: string | null }> {
  const now = new Date().toISOString()
  const { data: event, error } = await db().from('project_share_events')
    .update({ status: 'applying', decided_by_slack_user_id: slackUserId, updated_at: now })
    .eq('id', eventId).eq('status', 'pending').select('*').maybeSingle()
  if (error || !event) throw new Error(error?.message || 'This share was already handled')
  try {
    if (!event.suggested_milestone) throw new Error('Kit could not identify a milestone; update the Workback manually')
    const { data: project } = await db().from('projects').select('id,name,project_code,external_ids,project_manager_slack_id').eq('id', event.project_id).maybeSingle()
    if (!project) throw new Error('Project not found')
    if (project.project_manager_slack_id && project.project_manager_slack_id !== slackUserId) throw new Error('Only the project producer can advance this workback')
    const projectNumber = project.external_ids?.project_number || String(project.project_code || '').split('-')[0]
    const config = workbookConfigFromEnv()
    if (!config) throw new Error('Project Control workbook is not configured')
    const advanced = await advanceWorkbackForShare(config, project.id, projectNumber, event.suggested_milestone, `<@${slackUserId}>`)
    await db().from('project_share_events').update({ status: 'applied', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', eventId).eq('status', 'applying')
    if (!(await requestProjectControlSync(config, config.workbackSheetId || config.sheetId))) {
      console.warn('[project-control] immediate workback refresh unavailable; cron will reconcile')
    }
    return { projectName: project.name, milestone: event.suggested_milestone, nextMilestone: advanced.nextMilestone }
  } catch (err) {
    await db().from('project_share_events').update({ status: 'pending', decided_by_slack_user_id: null, updated_at: new Date().toISOString() }).eq('id', eventId).eq('status', 'applying')
    throw err
  }
}

export async function dismissProjectShare(eventId: string, slackUserId: string): Promise<void> {
  const { data: event } = await db().from('project_share_events').select('project_id').eq('id', eventId).eq('status', 'pending').maybeSingle()
  if (!event) throw new Error('This share was already handled')
  const { data: project } = await db().from('projects').select('project_manager_slack_id').eq('id', event.project_id).maybeSingle()
  if (project?.project_manager_slack_id && project.project_manager_slack_id !== slackUserId) throw new Error('Only the project producer can dismiss this prompt')
  await db().from('project_share_events').update({ status: 'dismissed', decided_by_slack_user_id: slackUserId, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', eventId).eq('status', 'pending')
}
