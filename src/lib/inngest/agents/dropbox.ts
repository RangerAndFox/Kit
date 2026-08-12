/**
 * Dropbox Agent — File Storage & Organization Expert
 *
 * Knows everything about the studio's Dropbox: project folder structures,
 * file search, sharing links, template management, and asset organization.
 * Kit routes any file/folder/storage question here.
 */

import { withRetry } from '@/lib/provisioner/retry'
import { deriveDropboxSafeName } from '@/lib/provisioner/identifiers'
import { dropboxHeaders } from '@/lib/dropbox/client'
import type { AgentDefinition, AgentResult } from './types'

const DROPBOX_API = 'https://api.dropboxapi.com/2'

/** Recover the project number from an agent payload: explicit projectNumber,
 *  else the leading segment of a legacy `{number}-{client}` projectCode. Shared
 *  by provision() and moveFolder() so the fallback lives in one place. */
function getProjectNumber(payload: Record<string, unknown>): string {
  return (
    (payload.projectNumber as string) ||
    (typeof payload.projectCode === 'string' ? (payload.projectCode as string).split('-')[0] : '') ||
    ''
  )
}

async function dropboxPost(endpoint: string, body: Record<string, unknown>): Promise<any> {
  return withRetry(async () =>
    fetch(`${DROPBOX_API}${endpoint}`, {
      method: 'POST',
      headers: await dropboxHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
      return r.json()
    })
  )
}

/**
 * Ensure the delivery watch folders exist under a project:
 *   <projectPath>/specs/video  and  <projectPath>/specs/audio
 * Idempotent — tolerates "already exists" conflicts. Creates `specs` first so
 * the subfolders always have a parent.
 */
export async function ensureSpecsFolders(projectPath: string): Promise<void> {
  for (const sub of ['specs', 'specs/video', 'specs/audio']) {
    try {
      await dropboxPost('/files/create_folder_v2', {
        path: `${projectPath}/${sub}`,
        autorename: false,
      })
    } catch (err: any) {
      // path/conflict/folder → already there; anything else is a real failure.
      if (!/conflict/i.test(err?.message || '')) throw err
    }
  }
}

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  const templatePath = process.env.DROPBOX_TEMPLATE_PATH ?? '/_TEMPLATES/New Project Template'
  const year = new Date().getFullYear()

  // Accept either `client`/`clientName` and either explicit projectNumber or
  // a parseable projectCode like "2655-Microsoft". Match the {ID}_{Client}_{Project} spine.
  const client = (payload.client as string) || (payload.clientName as string) || ''
  const projectName = (payload.projectName as string) || ''
  const projectNumber = getProjectNumber(payload)

  const labelParts = [projectNumber, client, projectName]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean)
  if (labelParts.length === 0) {
    return {
      agent: 'dropbox',
      action: 'provision',
      success: false,
      error: 'Dropbox provision needs at least one of projectNumber, client, projectName',
    }
  }
  // Shared derivation (see identifiers.ts) — identical output to the create
  // handler and the update flow, so reconciliation-by-path never diverges.
  const safeName = deriveDropboxSafeName(projectNumber, client, projectName)
  // Bot's Dropbox home namespace is already the team folder root, so paths
  // are relative to it. Prefixing /Ranger & Fox/ would create a duplicate
  // top-level folder inside the team folder. Same logic for DROPBOX_TEMPLATE_PATH.
  const destPath = `/production/${year}/${safeName}`

  try {
    try {
      await dropboxPost('/files/copy_v2', {
        from_path: templatePath,
        to_path: destPath,
        allow_ownership_transfer: false,
      })
    } catch (err: any) {
      // copy_v2 is retried by withRetry but isn't idempotent: a timeout whose
      // first attempt actually landed makes the retry hit a to_path conflict
      // — the folder exists, which is the outcome we wanted. Treat the
      // conflict as success and continue provisioning.
      if (!/conflict/i.test(err?.message || '')) throw err
      console.warn(`[dropbox:provision] ${destPath} already exists — continuing`)
    }

    // Delivery watch folders — drop a picture in specs/video and its mix in
    // specs/audio and Kit prompts for the spec + renders. Created explicitly so
    // they exist even if the Dropbox template doesn't carry them.
    await ensureSpecsFolders(destPath)

    const linkRes = await dropboxPost('/sharing/create_shared_link_with_settings', {
      path: destPath,
      settings: { requested_visibility: 'team_only' },
    })

    return {
      agent: 'dropbox',
      action: 'provision',
      success: true,
      url: linkRes.url,
      id: destPath,
      message: `Created project folder at ${destPath}`,
      data: { folderName: safeName, path: destPath },
    }
  } catch (err: any) {
    return { agent: 'dropbox', action: 'provision', success: false, error: err.message }
  }
}

async function searchFiles(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const query = payload.query as string
    const path = (payload.path as string) || ''

    const body: Record<string, unknown> = {
      query,
      options: {
        max_results: 20,
        file_status: 'active',
      },
    }
    if (path) {
      body.options = { ...body.options as object, path_filter: { path } }
    }

    const data = await dropboxPost('/files/search_v2', body)
    const matches = (data.matches || []).map((m: any) => ({
      name: m.metadata?.metadata?.name,
      path: m.metadata?.metadata?.path_display,
      type: m.metadata?.metadata?.['.tag'],
      modified: m.metadata?.metadata?.server_modified,
    }))

    return {
      agent: 'dropbox',
      action: 'search',
      success: true,
      message: `Found ${matches.length} result(s) for "${query}"`,
      data: { matches },
    }
  } catch (err: any) {
    return { agent: 'dropbox', action: 'search', success: false, error: err.message }
  }
}

async function listFolder(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    // Same namespace note as provision: the bot's Dropbox home is the team
    // folder root, so the canonical path is /production (no /Ranger & Fox/ prefix).
    const path = (payload.path as string) || '/production'
    const data = await dropboxPost('/files/list_folder', {
      path,
      limit: 50,
      include_mounted_folders: true,
    })

    const entries = (data.entries || []).map((e: any) => ({
      name: e.name,
      type: e['.tag'],
      path: e.path_display,
      modified: e.server_modified,
      size: e.size,
    }))

    return {
      agent: 'dropbox',
      action: 'list_folder',
      success: true,
      message: `${entries.length} items in ${path}`,
      data: { path, entries, hasMore: data.has_more },
    }
  } catch (err: any) {
    return { agent: 'dropbox', action: 'list_folder', success: false, error: err.message }
  }
}

async function getShareLink(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const path = payload.path as string
    const linkRes = await dropboxPost('/sharing/create_shared_link_with_settings', {
      path,
      settings: { requested_visibility: (payload.visibility as string) || 'team_only' },
    })

    return {
      agent: 'dropbox',
      action: 'get_share_link',
      success: true,
      url: linkRes.url,
      message: `Share link created for ${path}`,
      data: { path, url: linkRes.url },
    }
  } catch (err: any) {
    // If link already exists, try to get existing one
    if (err.message?.includes('shared_link_already_exists')) {
      try {
        const existing = await dropboxPost('/sharing/list_shared_links', {
          path: payload.path,
          direct_only: true,
        })
        const link = existing.links?.[0]
        if (link) {
          return {
            agent: 'dropbox',
            action: 'get_share_link',
            success: true,
            url: link.url,
            message: `Existing share link for ${payload.path}`,
            data: { path: payload.path, url: link.url },
          }
        }
      } catch {}
    }
    return { agent: 'dropbox', action: 'get_share_link', success: false, error: err.message }
  }
}

async function getProjectFolder(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectQuery = (payload.project as string) || ''
    const year = (payload.year as number) || new Date().getFullYear()
    const basePath = `/production/${year}`

    // List the year folder and find matching projects
    const data = await dropboxPost('/files/list_folder', {
      path: basePath,
      limit: 100,
    })

    const query = projectQuery.toLowerCase()
    const matches = (data.entries || [])
      .filter((e: any) => e['.tag'] === 'folder' && e.name.toLowerCase().includes(query))
      .map((e: any) => ({
        name: e.name,
        path: e.path_display,
      }))

    return {
      agent: 'dropbox',
      action: 'find_project_folder',
      success: true,
      message: `Found ${matches.length} project folder(s) matching "${projectQuery}"`,
      data: { matches, basePath },
    }
  } catch (err: any) {
    return { agent: 'dropbox', action: 'find_project_folder', success: false, error: err.message }
  }
}

async function folderExists(path: string): Promise<boolean> {
  try {
    const md = await dropboxPost('/files/get_metadata', { path })
    return !!md && md['.tag'] === 'folder'
  } catch (err: any) {
    // Only a GENUINE absence is `false`. Any other error (transient 5xx / timeout /
    // rate-limit surviving withRetry) is "unknown" → re-throw. moveFolder's collision
    // guard reads folderExists(fromPath) to tell a completed move ("source gone")
    // from a live collision; a blip collapsed to `false` would misread a still-live
    // collision as "source gone" and repoint the project at the wrong folder.
    if (/not_found|not_a_folder/i.test(err?.message || '')) return false
    throw err
  }
}

async function resolveShareLink(path: string): Promise<string | undefined> {
  try {
    const linkRes = await dropboxPost('/sharing/create_shared_link_with_settings', {
      path,
      settings: { requested_visibility: 'team_only' },
    })
    return linkRes.url
  } catch (err: any) {
    if (err.message?.includes('shared_link_already_exists')) {
      try {
        const existing = await dropboxPost('/sharing/list_shared_links', { path, direct_only: true })
        return existing.links?.[0]?.url
      } catch {}
    }
    return undefined
  }
}

async function moveResult(toPath: string, newSafeName: string, oldPath: string): Promise<AgentResult> {
  // The shared link is file-id-based and survives a move, so the URL is stable;
  // resolve it for completeness (create → already_exists → list).
  const url = await resolveShareLink(toPath)
  return {
    agent: 'dropbox',
    action: 'rename',
    success: true,
    ...(url ? { url } : {}),
    id: toPath,
    message: `Moved project folder to ${toPath}`,
    // newSafeName + path let the executor keep external_ids.dropbox_safe_name and
    // external_links.dropbox in lockstep with the folder (delivery matching keys
    // off dropbox_safe_name, so this MUST stay consistent).
    data: { folderName: newSafeName, newSafeName, path: toPath, oldPath },
  }
}

/**
 * Move/rename a project's Dropbox folder when the project is updated. The folder
 * stays under its OWN year (derived from the current path, not today's year), so
 * a 2025 project keeps `/production/2025/...`. Idempotent: an already-moved
 * folder (to_path exists / from_path gone) is treated as success so a resume
 * never fails on a completed move.
 */
async function moveFolder(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const client = (payload.client as string) || (payload.clientName as string) || ''
    const projectName = (payload.projectName as string) || ''
    const projectNumber = getProjectNumber(payload)
    // The folder's CURRENT path — persisted at create as external_links.dropbox_id.
    // Without it we cannot know what to move (or which year folder it lives in).
    const fromPath = (payload.fromPath as string) || (payload.dropboxPath as string) || ''
    if (!fromPath) {
      return { agent: 'dropbox', action: 'rename', success: false, terminal: true, error: 'rename needs the current dropbox folder path (fromPath)' }
    }
    const newSafeName =
      (payload.newSafeName as string) || deriveDropboxSafeName(projectNumber, client, projectName)
    if (!newSafeName) {
      return { agent: 'dropbox', action: 'rename', success: false, error: 'rename needs at least one of projectNumber, client, projectName to build the new folder name' }
    }
    const segs = fromPath.split('/')
    const year = segs[2] || String(new Date().getFullYear())
    const toPath = `/production/${year}/${newSafeName}`

    if (fromPath === toPath) {
      return moveResult(toPath, newSafeName, fromPath) // already at target
    }

    try {
      await dropboxPost('/files/move_v2', { from_path: fromPath, to_path: toPath, autorename: false })
    } catch (err: any) {
      const msg = err?.message || ''
      if (!(/conflict/i.test(msg) || /not_found|from_lookup|not_a_folder/i.test(msg))) throw err
      // Accept the error as an already-completed move ONLY on the true signal a
      // finished move leaves: the SOURCE is gone AND the destination exists. Folders
      // carry no Kit marker (unlike Slack/Harvest/Frame.io reconcile-by-marker), so
      // destination-exists ALONE is not proof it's OUR folder. A to_path conflict
      // while fromPath still exists means a DIFFERENT folder (a safe-name collision
      // or a manual scratch folder) occupies toPath — repointing dropbox_safe_name
      // at it would orphan the real folder. That's terminal: retrying the same
      // occupied destination can never succeed.
      const [srcExists, destExists] = await Promise.all([folderExists(fromPath), folderExists(toPath)])
      if (!srcExists && destExists) {
        console.warn(`[dropbox:rename] source gone and ${toPath} present — treating move as done`)
      } else if (srcExists && destExists) {
        return { agent: 'dropbox', action: 'rename', success: false, terminal: true, error: `dropbox_move_conflict: ${toPath} is occupied by another folder while ${fromPath} still exists` }
      } else {
        throw err // dest missing (or both gone) → not a completed move; retryable
      }
    }

    return moveResult(toPath, newSafeName, fromPath)
  } catch (err: any) {
    return { agent: 'dropbox', action: 'rename', success: false, error: err.message }
  }
}

// ─── Agent Definition ──────────────────────────────────────

export const dropboxAgent: AgentDefinition = {
  id: 'dropbox',
  name: 'Dropbox Agent',
  domain: 'Dropbox',
  expertise:
    'File storage, project folder structures, asset organization, file search, and share links. Ask me to find files, get share links, browse project folders, or set up new project folder structures from templates.',
  requiredEnvVars: ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN'],
  capabilities: [
    {
      action: 'provision',
      description: 'Clone the project template folder into a new project directory with a team share link',
      inputDescription:
        'projectName (required), client (required), projectNumber (the project ID, e.g. "2655" — REQUIRED for proper {number}_{client}_{project} folder naming)',
      mutates: true,
    },
    {
      action: 'rename',
      description: 'Move/rename a project folder when a project is updated. Stays under its original year; idempotent on resume. Returns the new path + safe-name so callers keep delivery matching in sync.',
      inputDescription: 'fromPath (required, current /production/{year}/{safeName}), projectName, client, projectNumber (used to build the new folder name), or newSafeName to override',
      mutates: true,
    },
    {
      action: 'search',
      description: 'Search for files and folders by name across the entire Dropbox or within a specific path',
      inputDescription: 'query (search term), path (optional, scope to a folder)',
      mutates: false,
    },
    {
      action: 'list_folder',
      description: 'List contents of a folder. Defaults to the Production root.',
      inputDescription: 'path (folder path, defaults to /production)',
      mutates: false,
    },
    {
      action: 'get_share_link',
      description: 'Create or retrieve a share link for a file or folder',
      inputDescription: 'path (file/folder path), visibility (team_only or public)',
      mutates: true,
    },
    {
      action: 'find_project_folder',
      description: 'Find a project folder by name in the Production directory for a given year',
      inputDescription: 'project (name to search), year (optional, defaults to current year)',
      mutates: false,
    },
  ],
  handler: async (action, payload) => {
    switch (action) {
      case 'provision':
        return provision(payload)
      case 'rename':
        return moveFolder(payload)
      case 'search':
        return searchFiles(payload)
      case 'list_folder':
        return listFolder(payload)
      case 'get_share_link':
        return getShareLink(payload)
      case 'find_project_folder':
        return getProjectFolder(payload)
      default:
        return { agent: 'dropbox', action, success: false, error: `Unknown action: ${action}` }
    }
  },
}
