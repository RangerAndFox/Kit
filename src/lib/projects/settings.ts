/**
 * Per-project settings (Option B: a `project_settings` table keyed by
 * project_id). A missing row means "all defaults" — callers never have to seed
 * a row when a project is created; the absence IS the default.
 *
 * Currently the only setting is the Frame.io delivery-upload toggle. Shared
 * between the Bolt conversational handler (reads/writes the toggle) and the
 * Dropbox->Frame.io watcher (reads it before mirroring a delivery).
 */
import { createAdminClient } from '../supabase/admin'

export interface ProjectSettings {
  frameio_upload_enabled: boolean
}

const DEFAULTS: ProjectSettings = {
  frameio_upload_enabled: true,
}

/**
 * Read a project's settings, falling back to defaults when there's no row (or
 * on a read error — we never want a settings hiccup to silently change
 * delivery behavior, so the default is the safe "enabled" state).
 */
export async function getProjectSettings(projectId: string): Promise<ProjectSettings> {
  if (!projectId) return { ...DEFAULTS }
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('project_settings')
    .select('frameio_upload_enabled')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) {
    console.warn(`[project-settings] read failed for ${projectId}: ${error.message}`)
    return { ...DEFAULTS }
  }
  if (!data) return { ...DEFAULTS }
  return {
    frameio_upload_enabled: data.frameio_upload_enabled ?? DEFAULTS.frameio_upload_enabled,
  }
}

export async function isFrameioUploadEnabled(projectId: string): Promise<boolean> {
  return (await getProjectSettings(projectId)).frameio_upload_enabled
}

/**
 * Upsert the Frame.io upload toggle for a project. Throws on a hard DB error so
 * the caller can surface it to the user.
 */
export async function setFrameioUploadEnabled(
  projectId: string,
  enabled: boolean,
  updatedBy?: string,
): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb.from('project_settings').upsert(
    {
      project_id: projectId,
      frameio_upload_enabled: enabled,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id' },
  )
  if (error) throw new Error(error.message)
}
