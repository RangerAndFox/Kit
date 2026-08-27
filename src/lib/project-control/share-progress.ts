import { createAdminClient } from '@/lib/supabase/admin'
import { workbookConfigFromEnv } from './types'
import { advanceWorkbackForShare, readProjectSupplement, recordLatestShare } from './sheets'
import { matchMilestone } from './workback'
import { requestProjectControlSync } from './sync-request'

// These tables are introduced by the accompanying migration and are not yet in
// the checked-in generated Database type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createAdminClient() as any

export async function registerProjectShare(input: {
  projectId: string
  projectNumber: string
  dropboxFileId: string
  dropboxRev: string
  fileName: string
  shareUrl: string
}): Promise<{ eventId: string | null; milestone: string | null; confidence: 'exact' | 'probable' | 'uncertain' }> {
  const config = workbookConfigFromEnv()
  let match: ReturnType<typeof matchMilestone> = { task: null, confidence: 'uncertain' }
  if (config) {
    const extra = await readProjectSupplement(config, input.projectNumber)
    match = matchMilestone(input.fileName, extra.workback.map((w) => w.Task))
    await recordLatestShare(config, input.projectId, { label: input.fileName, url: input.shareUrl, date: new Date().toISOString().slice(0, 10), milestone: match.task })
    if (!(await requestProjectControlSync(config, config.sheetId))) {
      console.warn('[project-control] immediate Latest Share refresh unavailable; cron will reconcile')
    }
  }
  const { data, error } = await db().from('project_share_events').upsert({
    project_id: input.projectId, dropbox_file_id: input.dropboxFileId, dropbox_rev: input.dropboxRev,
    file_name: input.fileName, share_url: input.shareUrl, suggested_milestone: match.task,
    match_confidence: match.confidence, status: 'pending', updated_at: new Date().toISOString(),
  }, { onConflict: 'project_id,dropbox_file_id,dropbox_rev', ignoreDuplicates: true }).select('id').maybeSingle()
  if (error) throw new Error(`registerProjectShare: ${error.message}`)
  return { eventId: data?.id || null, milestone: match.task, confidence: match.confidence }
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
