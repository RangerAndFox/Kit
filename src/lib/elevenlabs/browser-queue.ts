import { createAdminClient } from '@/lib/supabase/admin'

export async function queueElevenLabsStudioJob(input: {
  storyboardJobId: string
  workspaceId?: string | null
  requestedBySlackUserId?: string | null
  slackChannelId?: string | null
  slackThreadTs?: string | null
  projectName: string
  voiceoverParagraphs: string[]
}): Promise<string> {
  // The generated Database type is refreshed after the migration is applied;
  // keep this server-only queue usable during the same release that adds it.
  const supabase = createAdminClient() as any
  const row = {
    storyboard_job_id: input.storyboardJobId,
    workspace_id: input.workspaceId || process.env.KIT_DEFAULT_WORKSPACE_ID || null,
    requested_by_slack_user_id: input.requestedBySlackUserId || null,
    slack_channel_id: input.slackChannelId || null,
    slack_thread_ts: input.slackThreadTs || null,
    project_name: input.projectName.trim(),
    voiceover_paragraphs: input.voiceoverParagraphs,
    status: 'queued',
    error: null,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('elevenlabs_studio_jobs')
    .upsert(row, { onConflict: 'storyboard_job_id' })
    .select('id')
    .single()
  if (error) throw new Error(`Could not queue ElevenLabs Studio draft: ${error.message}`)
  return String(data.id)
}
