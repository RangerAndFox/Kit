// @ts-nocheck
/**
 * Project external_links rehydration.
 *
 * Older / partially-provisioned projects sometimes have an incomplete
 * external_links blob — e.g. only frameio_id but no slack_id or
 * dropbox_id or harvest_id. Before onboarding services run, we try to
 * discover each missing piece by querying the underlying API:
 *
 *   slack_id     → conversations.list, match by project_code in name
 *   dropbox_id   → derive from external_ids.dropbox_safe_name + year
 *   harvest_id   → searchProjects by project_code (exact match preferred)
 *   frameio_url  → derived from frameio_id
 *   dropbox_url  → /sharing/get_shared_link_metadata if folder is shared
 *
 * Anything discovered is persisted back to public.projects.external_links
 * so subsequent runs don't repeat the lookup.
 */
import type { App } from '@slack/bolt'
import type { OnboardingProject } from './types'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { searchProjects as harvestSearchProjects } from '../../../src/lib/harvest/client'
import { dropboxHeaders } from '../../../src/lib/dropbox/client'

interface RehydrateResult {
  discovered: string[]
  alreadyHad: string[]
  missing: string[]
}

/**
 * Find the project's Slack channel by listing channels and matching on
 * project_code. Walks the first ~5 pages to cap cost.
 */
async function findSlackChannel(
  app: App,
  projectCode: string | null,
): Promise<string | null> {
  if (!projectCode) return null
  const code = projectCode.toLowerCase()
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const r = await app.client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    if (!r.ok) return null
    const match = (r.channels || []).find((c: any) =>
      (c.name || '').toLowerCase().includes(code),
    )
    if (match) return match.id
    cursor = r.response_metadata?.next_cursor
    if (!cursor) break
  }
  return null
}

/**
 * Derive the Dropbox folder path for a project. Prefers external_ids.dropbox_safe_name
 * (canonical from provisioner); otherwise reconstructs from client+name.
 */
function deriveDropboxPath(project: OnboardingProject): string | null {
  const safeName: string | undefined = project.external_ids?.dropbox_safe_name
  const year = new Date().getFullYear() // best-effort; could read created_at
  if (safeName) {
    return `/Ranger & Fox/Production/${year}/${safeName}`
  }
  if (project.client && project.name) {
    const slug = `${project.client}_${project.name}`
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
    return `/Ranger & Fox/Production/${year}/${slug}`
  }
  return null
}

/**
 * Confirm a Dropbox folder exists at path. Returns true if so.
 */
async function dropboxFolderExists(path: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
      method: 'POST',
      headers: await dropboxHeaders(),
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Search Harvest for the project by project_code; prefer an exact code match.
 */
async function findHarvestProjectId(
  projectCode: string | null,
  projectName: string | null,
): Promise<number | null> {
  if (!projectCode && !projectName) return null
  const query = projectCode || projectName || ''
  try {
    const matches = await harvestSearchProjects(query)
    if (matches.length === 0) return null
    if (projectCode) {
      const exact = matches.find(
        (p: any) =>
          (p.code || '').toLowerCase() === projectCode.toLowerCase(),
      )
      if (exact) return exact.id
    }
    return matches[0].id
  } catch {
    return null
  }
}

/**
 * Run rehydration on a project. Mutates external_links in Supabase.
 * Returns a brief summary for logging.
 */
export async function rehydrateProjectExternalLinks(opts: {
  app: App
  project: OnboardingProject
}): Promise<RehydrateResult> {
  const { app, project } = opts
  const sb = createAdminClient()
  const links = { ...(project.external_links || {}) }
  const discovered: string[] = []
  const alreadyHad: string[] = []
  const missing: string[] = []

  // ── Slack channel ────────────────────────────────────────
  if (links.slack_id) {
    alreadyHad.push('slack_id')
  } else {
    const channelId = await findSlackChannel(app, project.project_code)
    if (channelId) {
      links.slack_id = channelId
      discovered.push('slack_id')
    } else {
      missing.push('slack_id')
    }
  }

  // ── Dropbox path ─────────────────────────────────────────
  if (links.dropbox_id) {
    alreadyHad.push('dropbox_id')
  } else {
    const path = deriveDropboxPath(project)
    if (path && (await dropboxFolderExists(path))) {
      links.dropbox_id = path
      discovered.push('dropbox_id')
    } else {
      missing.push('dropbox_id')
    }
  }

  // ── Frame.io URL (derived) ───────────────────────────────
  if (!links.frameio_url && links.frameio_id) {
    links.frameio_url = `https://next.frame.io/project/${links.frameio_id}`
    discovered.push('frameio_url')
  }

  // ── Harvest project id ───────────────────────────────────
  if (links.harvest_id) {
    alreadyHad.push('harvest_id')
  } else {
    const id = await findHarvestProjectId(project.project_code, project.name)
    if (id) {
      links.harvest_id = String(id)
      discovered.push('harvest_id')
    } else {
      missing.push('harvest_id')
    }
  }

  // Persist if anything new was discovered
  if (discovered.length > 0) {
    const { error } = await sb
      .from('projects')
      .update({ external_links: links })
      .eq('id', project.id)
    if (error) {
      console.warn(`[rehydrate] update failed for ${project.id}: ${error.message}`)
    } else {
      // Mutate the in-memory project so the orchestrator sees the new keys.
      project.external_links = links
    }
  }

  return { discovered, alreadyHad, missing }
}
