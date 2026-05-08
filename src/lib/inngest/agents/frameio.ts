// @ts-nocheck
/**
 * Frame.io Agent — Review & Approval Expert (v4 API)
 *
 * Knows everything about Frame.io: review projects, comment extraction,
 * approval status, version tracking, and asset management.
 * Kit routes any review/approval/feedback question here.
 *
 * Auth: Adobe IMS OAuth via src/lib/frameio/auth.ts
 * API:  https://api.frame.io/v4/accounts/{account_id}/...
 */

import { withRetry } from '@/lib/provisioner/retry'
import folderStructure from '@/lib/provisioner/folder-structure.json'
import { frameIoAuthHeaders } from '@/lib/frameio/auth'
import type { AgentDefinition, AgentResult } from './types'

const FRAMEIO_API = 'https://api.frame.io/v4'

function accountId(): string {
  const id = process.env.FRAMEIO_ACCOUNT_ID
  if (!id) throw new Error('FRAMEIO_ACCOUNT_ID not configured')
  return id
}

function workspaceId(): string {
  const id = process.env.FRAMEIO_WORKSPACE_ID
  if (!id) throw new Error('FRAMEIO_WORKSPACE_ID not configured')
  return id
}

async function frameGet(path: string): Promise<any> {
  return withRetry(async () => {
    const headers = await frameIoAuthHeaders()
    const r = await fetch(`${FRAMEIO_API}${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
    return r.json()
  })
}

async function framePost(path: string, body: Record<string, unknown>): Promise<any> {
  return withRetry(async () => {
    const headers = await frameIoAuthHeaders()
    const r = await fetch(`${FRAMEIO_API}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: body }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
    return r.json()
  })
}

function unwrap(payload: any): any {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
}

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  const projectLabel = payload.projectCode
    ? `${payload.projectCode}_${payload.client}_${payload.projectName}`
    : `${payload.client}_${payload.projectName}`

  try {
    const acct = accountId()
    const ws = workspaceId()

    const project = unwrap(
      await framePost(`/accounts/${acct}/workspaces/${ws}/projects`, {
        name: projectLabel,
      })
    )

    const rootFolderId: string = project.root_folder_id || project.root_asset_id

    const folders = folderStructure.frameio || []
    const results = await Promise.allSettled(
      folders.map((name: string) =>
        framePost(`/accounts/${acct}/folders/${rootFolderId}/folders`, { name })
      )
    )

    const created = results.filter((r) => r.status === 'fulfilled').length

    return {
      agent: 'frameio',
      action: 'provision',
      success: true,
      url: `https://next.frame.io/project/${project.id}`,
      id: project.id,
      message: `Created Frame.io project "${projectLabel}" with ${created}/${folders.length} folders`,
      data: { rootFolderId, foldersCreated: created },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'provision', success: false, error: err.message }
  }
}

async function getComments(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const fileId = payload.assetId as string
    const acct = accountId()
    const data = unwrap(await frameGet(`/accounts/${acct}/files/${fileId}/comments`))
    const comments = Array.isArray(data) ? data : (data?.comments || data?.items || [])

    const parsed = comments.map((c: any) => ({
      id: c.id,
      text: c.text || c.body || '',
      author: c.owner?.name || c.author?.name || c.owner?.email || 'Unknown',
      timestamp: c.timestamp,
      createdAt: c.created_at || c.inserted_at,
      hasAnnotation: !!c.annotation,
      completed: c.completed || c.resolved || false,
    }))

    return {
      agent: 'frameio',
      action: 'get_comments',
      success: true,
      message: `${parsed.length} comments on file`,
      data: { assetId: fileId, comments: parsed },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'get_comments', success: false, error: err.message }
  }
}

async function getProject(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectId = payload.projectId as string
    const acct = accountId()
    const project = unwrap(await frameGet(`/accounts/${acct}/projects/${projectId}`))

    return {
      agent: 'frameio',
      action: 'get_project',
      success: true,
      url: `https://next.frame.io/project/${project.id}`,
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
    const folderId = payload.parentId as string
    const acct = accountId()
    const data = unwrap(await frameGet(`/accounts/${acct}/folders/${folderId}/children`))
    const assets = Array.isArray(data) ? data : (data?.items || data?.children || [])

    const parsed = assets.map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type || a.kind,
      status: a.label || a.review_status,
      commentCount: a.comment_count ?? a.comments_count,
      versions: a.version_count ?? a.versions,
      createdAt: a.created_at,
    }))

    return {
      agent: 'frameio',
      action: 'list_assets',
      success: true,
      message: `${parsed.length} assets found`,
      data: { assets: parsed },
    }
  } catch (err: any) {
    return { agent: 'frameio', action: 'list_assets', success: false, error: err.message }
  }
}

async function getReviewStatus(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectId = payload.projectId as string
    const acct = accountId()
    const project = unwrap(await frameGet(`/accounts/${acct}/projects/${projectId}`))
    const rootFolderId = project.root_folder_id || project.root_asset_id

    const data = unwrap(await frameGet(`/accounts/${acct}/folders/${rootFolderId}/children`))
    const rootAssets = Array.isArray(data) ? data : (data?.items || data?.children || [])

    const summary = {
      totalAssets: 0,
      withComments: 0,
      totalComments: 0,
      approved: 0,
      needsReview: 0,
    }

    for (const asset of rootAssets) {
      if (asset.type === 'file' || asset.kind === 'file') {
        summary.totalAssets++
        const count = asset.comment_count ?? asset.comments_count ?? 0
        if (count > 0) {
          summary.withComments++
          summary.totalComments += count
        }
        const label = asset.label || asset.review_status
        if (label === 'approved') summary.approved++
        else if (label === 'needs_review') summary.needsReview++
      }
    }

    return {
      agent: 'frameio',
      action: 'get_review_status',
      success: true,
      message: `${summary.totalAssets} assets: ${summary.approved} approved, ${summary.needsReview} need review, ${summary.totalComments} total comments`,
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
    'ADOBE_CLIENT_ID',
    'ADOBE_CLIENT_SECRET',
    'ADOBE_REFRESH_TOKEN',
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
      inputDescription: 'assetId (Frame.io file UUID)',
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
      description: 'List all files/folders inside a parent folder',
      inputDescription: 'parentId (folder UUID of the parent)',
      mutates: false,
    },
    {
      action: 'get_review_status',
      description: 'Get a summary of review status across all files in a project — how many approved, need review, total comments',
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
