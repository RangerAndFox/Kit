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

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  const projectLabel = payload.projectCode
    ? `${payload.projectCode}_${payload.client}_${payload.projectName}`
    : `${payload.client}_${payload.projectName}`

  try {
    const acct = getAccountId()
    const ws = getWorkspaceId()

    // v4: POST /v4/accounts/{account_id}/workspaces/{workspace_id}/projects
    const resp = await framePost(`/accounts/${acct}/workspaces/${ws}/projects`, {
      data: { name: projectLabel },
    })
    const project = resp.data || resp

    // Get the project's root folder ID
    // v4: the project response should include root_folder_id or similar
    const rootFolderId = project.root_folder_id || project.root_asset_id

    if (!rootFolderId) {
      // If root folder ID isn't in the response, list the project's folders
      const projDetail = await frameGet(`/accounts/${acct}/projects/${project.id}`)
      const projData = projDetail.data || projDetail
      const folderId = projData.root_folder_id || projData.root_asset_id
      if (!folderId) throw new Error('Could not determine project root folder ID')
    }

    const parentId = rootFolderId || project.root_folder_id

    // v4: POST /v4/accounts/{account_id}/folders/{parent_id}/folders
    const folders = folderStructure.frameio || []
    const results = await Promise.allSettled(
      folders.map((name: string) =>
        framePost(`/accounts/${acct}/folders/${parentId}/folders`, {
          data: { name },
        })
      )
    )

    const created = results.filter((r) => r.status === 'fulfilled').length

    return {
      agent: 'frameio',
      action: 'provision',
      success: true,
      url: `https://app.frame.io/projects/${project.id}`,
      id: project.id,
      message: `Created Frame.io project "${projectLabel}" with ${created}/${folders.length} folders`,
      data: { rootFolderId: parentId, foldersCreated: created },
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
