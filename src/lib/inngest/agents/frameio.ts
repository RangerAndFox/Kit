// @ts-nocheck
/**
 * Frame.io Agent — Review & Approval Expert (v4 API)
 *
 * Migrated from v2 to v4. Key changes:
 *   - Base URL: /v4 instead of /v2
 *   - "teams" → "workspaces", "assets" → "files/folders"
 *   - All paths include account_id prefix
 *   - Responses wrapped in { data: ... }
 *   - Request bodies use { data: { ... } }
 *   - Projects created under workspaces, not teams
 *   - Folders created under parent folders
 */

import { withRetry } from '@/lib/provisioner/retry'
import { frameioHeaders } from '@/lib/frameio/auth'
import folderStructure from '@/lib/provisioner/folder-structure.json'
import type { AgentDefinition, AgentResult } from './types'

const FRAMEIO_API = 'https://api.frame.io/v4'

function getAccountId(): string {
  const id = process.env.FRAMEIO_ACCOUNT_ID
  if (!id) throw new Error('FRAMEIO_ACCOUNT_ID is required')
  return id
}

function getWorkspaceId(): string {
  const id = process.env.FRAMEIO_WORKSPACE_ID
  if (!id) throw new Error('FRAMEIO_WORKSPACE_ID is required')
  return id
}

async function frameGet(path: string): Promise<any> {
  return withRetry(async () => {
    const hdrs = await frameioHeaders()
    return fetch(`${FRAMEIO_API}${path}`, {
      headers: hdrs,
      signal: AbortSignal.timeout(15_000),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
      return r.json()
    })
  })
}

async function framePost(path: string, body: Record<string, unknown>): Promise<any> {
  return withRetry(async () => {
    const hdrs = await frameioHeaders()
    return fetch(`${FRAMEIO_API}${path}`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
      return r.json()
    })
  })
}

/**
 * Single-attempt POST — for non-idempotent creates where a retried timeout
 * whose first attempt actually landed would duplicate the resource (e.g.
 * project creation: two "2628_Crunchyroll_Expo" projects).
 */
async function framePostOnce(path: string, body: Record<string, unknown>): Promise<any> {
  const hdrs = await frameioHeaders()
  const r = await fetch(`${FRAMEIO_API}${path}`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json()
}

/**
 * Recursively mirror a Frame.io folder tree, structure only.
 * Walks every folder under `sourceFolderId` and creates an equivalent under
 * `destFolderId` in the new project. Files, comments, and shares are not
 * copied — just the folder names + hierarchy.
 *
 * Bounded by MAX_DEPTH so a pathological template can't run away.
 */
const MAX_TEMPLATE_DEPTH = 8

async function copyFrameioFolderTree(
  acct: string,
  sourceFolderId: string,
  destFolderId: string,
  depth: number,
): Promise<{ created: number; total: number }> {
  if (depth > MAX_TEMPLATE_DEPTH) return { created: 0, total: 0 }

  const childrenResp = await frameGet(`/accounts/${acct}/folders/${sourceFolderId}/children`)
  const children = childrenResp.data || childrenResp.items || childrenResp || []
  const folderChildren = (Array.isArray(children) ? children : []).filter((c: any) => {
    const t = c.type || c.resource_type
    return t === 'folder'
  })

  let created = 0
  let total = folderChildren.length

  for (const child of folderChildren) {
    try {
      const resp = await framePost(`/accounts/${acct}/folders/${destFolderId}/folders`, {
        data: { name: child.name },
      })
      const newFolder = resp.data || resp
      const newFolderId: string | undefined = newFolder.id
      created++

      if (newFolderId) {
        const sub = await copyFrameioFolderTree(acct, child.id, newFolderId, depth + 1)
        created += sub.created
        total += sub.total
      }
    } catch (err: any) {
      console.warn(`[frameio] could not copy folder "${child.name}":`, err.message)
    }
  }

  return { created, total }
}

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  // Accept `client` or `clientName` — modal flow sends both, NL specialists vary.
  const client = (payload.client as string) || (payload.clientName as string) || ''
  const projectName = (payload.projectName as string) || ''
  const projectNumber = (payload.projectNumber as string) || ''

  // Standard label: {number}_{client}_{project}, falling back gracefully.
  const projectLabel = [projectNumber, client, projectName]
    .filter((part) => part && part.trim())
    .join('_')

  if (!projectLabel) {
    return {
      agent: 'frameio',
      action: 'provision',
      success: false,
      error: 'Frame.io provision needs at least one of projectNumber, client, projectName',
    }
  }

  try {
    const acct = getAccountId()
    const ws = getWorkspaceId()

    // v4: POST /v4/accounts/{account_id}/workspaces/{workspace_id}/projects
    // Single attempt — a retried timeout that actually landed would create a
    // second project with the same name.
    const resp = await framePostOnce(`/accounts/${acct}/workspaces/${ws}/projects`, {
      data: { name: projectLabel },
    })
    const project = resp.data || resp

    // Determine the project's root folder ID. v4 sometimes returns it on the
    // create response (root_folder_id or root_asset_id); when it doesn't, fetch
    // the project detail to get it.
    let parentId: string | undefined = project.root_folder_id || project.root_asset_id

    if (!parentId) {
      const projDetail = await frameGet(`/accounts/${acct}/projects/${project.id}`)
      const projData = projDetail.data || projDetail
      parentId = projData.root_folder_id || projData.root_asset_id
    }

    if (!parentId) throw new Error('Could not determine project root folder ID')

    // If a template project is configured, mirror its folder structure
    // (recursively, folders only — files/comments are not duplicated).
    // Falls back to folder-structure.json frameio list when env var is unset.
    const templateProjectId = process.env.FRAMEIO_TEMPLATE_PROJECT_ID
    let foldersCreated = 0
    let foldersTotal = 0
    let mode: 'template' | 'static' = 'static'

    if (templateProjectId) {
      mode = 'template'
      try {
        const tmplResp = await frameGet(`/accounts/${acct}/projects/${templateProjectId}`)
        const tmpl = tmplResp.data || tmplResp
        const tmplRootId: string | undefined = tmpl.root_folder_id || tmpl.root_asset_id
        if (!tmplRootId) {
          throw new Error('template project has no root_folder_id')
        }
        const result = await copyFrameioFolderTree(acct, tmplRootId, parentId, 0)
        foldersCreated = result.created
        foldersTotal = result.total
      } catch (err: any) {
        console.error('[frameio] template folder mirror failed:', err.message)
        // Fall through to static fallback
        mode = 'static'
      }
    }

    if (mode === 'static') {
      const folders = folderStructure.frameio || []
      foldersTotal = folders.length
      const results = await Promise.allSettled(
        folders.map((name: string) =>
          framePost(`/accounts/${acct}/folders/${parentId}/folders`, {
            data: { name },
          }),
        ),
      )
      foldersCreated = results.filter((r) => r.status === 'fulfilled').length
    }

    return {
      agent: 'frameio',
      action: 'provision',
      success: true,
      url: `https://app.frame.io/projects/${project.id}`,
      id: project.id,
      message: `Created Frame.io project "${projectLabel}" with ${foldersCreated}/${foldersTotal} folders (${mode})`,
      data: { rootFolderId: parentId, foldersCreated, foldersTotal, mode },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'provision', success: false, error: err.message }
  }
}

async function getComments(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const acct = getAccountId()
    const fileId = payload.assetId as string || payload.fileId as string

    // v4: GET /v4/accounts/{account_id}/files/{file_id}/comments
    const resp = await frameGet(`/accounts/${acct}/files/${fileId}/comments`)
    const comments = resp.data || resp

    const parsed = (Array.isArray(comments) ? comments : []).map((c: any) => ({
      id: c.id,
      text: c.text,
      author: c.owner?.name || c.creator?.name || c.owner?.email || 'Unknown',
      timestamp: c.timestamp,
      createdAt: c.created_at || c.inserted_at,
      hasAnnotation: !!c.annotation,
      completed: c.completed || c.resolved,
    }))

    return {
      agent: 'frameio',
      action: 'get_comments',
      success: true,
      message: `${parsed.length} comments on file`,
      data: { fileId, comments: parsed },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'get_comments', success: false, error: err.message }
  }
}

async function getProject(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const acct = getAccountId()
    const projectId = payload.projectId as string

    // v4: GET /v4/accounts/{account_id}/projects/{project_id}
    const resp = await frameGet(`/accounts/${acct}/projects/${projectId}`)
    const project = resp.data || resp

    return {
      agent: 'frameio',
      action: 'get_project',
      success: true,
      url: `https://app.frame.io/projects/${project.id}`,
      message: `Project: ${project.name}`,
      data: {
        id: project.id,
        name: project.name,
        rootFolderId: project.root_folder_id || project.root_asset_id,
        createdAt: project.created_at,
      },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'get_project', success: false, error: err.message }
  }
}

async function listAssets(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const acct = getAccountId()
    const parentId = payload.parentId as string || payload.folderId as string

    // v4: GET /v4/accounts/{account_id}/folders/{folder_id}/children
    const resp = await frameGet(`/accounts/${acct}/folders/${parentId}/children`)
    const children = resp.data || resp

    const parsed = (Array.isArray(children) ? children : []).map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type || a.resource_type,
      status: a.label || a.status,
      commentCount: a.comment_count,
      versions: a.versions,
      createdAt: a.created_at,
    }))

    return {
      agent: 'frameio',
      action: 'list_assets',
      success: true,
      message: `${parsed.length} items found`,
      data: { assets: parsed },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'list_assets', success: false, error: err.message }
  }
}

async function getReviewStatus(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const acct = getAccountId()
    const projectId = payload.projectId as string

    // Get project to find root folder
    const projResp = await frameGet(`/accounts/${acct}/projects/${projectId}`)
    const project = projResp.data || projResp
    const rootFolderId = project.root_folder_id || project.root_asset_id

    // v4: GET /v4/accounts/{account_id}/folders/{folder_id}/children
    const childResp = await frameGet(`/accounts/${acct}/folders/${rootFolderId}/children`)
    const rootChildren = childResp.data || childResp

    const summary = {
      totalAssets: 0,
      withComments: 0,
      totalComments: 0,
      approved: 0,
      needsReview: 0,
    }

    for (const item of (Array.isArray(rootChildren) ? rootChildren : [])) {
      if (item.type === 'file' || item.resource_type === 'file') {
        summary.totalAssets++
        if (item.comment_count > 0) {
          summary.withComments++
          summary.totalComments += item.comment_count
        }
        if (item.label === 'approved' || item.status === 'approved') summary.approved++
        else if (item.label === 'needs_review' || item.status === 'needs_review') summary.needsReview++
      }
    }

    return {
      agent: 'frameio',
      action: 'get_review_status',
      success: true,
      message: `${summary.totalAssets} files: ${summary.approved} approved, ${summary.needsReview} need review, ${summary.totalComments} total comments`,
      data: { projectId, ...summary },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'get_review_status', success: false, error: err.message }
  }
}

// ─── Agent Definition ──────────────────────────────────────

export const frameioAgent: AgentDefinition = {
  id: 'frameio',
  name: 'Frame.io Agent',
  domain: 'Frame.io',
  expertise:
    'Video review and approval workflows, client feedback, frame-accurate comments, asset versions, and review status tracking. Ask me about review comments, approval status, what feedback the client left, or to set up a new review project.',
  requiredEnvVars: [
    'FRAMEIO_ADOBE_CLIENT_ID',
    'FRAMEIO_ADOBE_CLIENT_SECRET',
    'FRAMEIO_ADOBE_REFRESH_TOKEN',
    'FRAMEIO_ACCOUNT_ID',
    'FRAMEIO_WORKSPACE_ID',
  ],
  capabilities: [
    {
      action: 'provision',
      description: 'Create a new Frame.io project with standard review folder structure',
      inputDescription:
        'projectName (required), client (required), projectNumber (the project ID, e.g. "2654" — REQUIRED for proper {number}_{client}_{project} naming)',
      mutates: true,
    },
    {
      action: 'get_comments',
      description: 'Get all review comments on a specific file (video/image)',
      inputDescription: 'fileId (Frame.io file UUID)',
      mutates: false,
    },
    {
      action: 'get_project',
      description: 'Get details of a Frame.io project',
      inputDescription: 'projectId (Frame.io project UUID)',
      mutates: false,
    },
    {
      action: 'list_assets',
      description: 'List all files/folders inside a parent folder or project root',
      inputDescription: 'folderId (UUID of the parent folder)',
      mutates: false,
    },
    {
      action: 'get_review_status',
      description: 'Get a summary of review status across all files in a project',
      inputDescription: 'projectId (Frame.io project UUID)',
      mutates: false,
    },
  ],
  handler: async (action, payload) => {
    switch (action) {
      case 'provision':
        return provision(payload)
      case 'get_comments':
        return getComments(payload)
      case 'get_project':
        return getProject(payload)
      case 'list_assets':
        return listAssets(payload)
      case 'get_review_status':
        return getReviewStatus(payload)
      default:
        return { agent: 'frameio', action, success: false, error: `Unknown action: ${action}` }
    }
  },
}
