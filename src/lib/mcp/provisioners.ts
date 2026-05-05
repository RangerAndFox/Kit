// @ts-nocheck
/**
 * MCP Project Provisioners
 *
 * Lightweight wrappers that create external resources when Kit provisions
 * a new project via the MCP tool. Each returns a result object with the
 * external ID and URL, or null on failure.
 *
 * These are intentionally simpler than the full provisioner service
 * (src/lib/provisioner/) — they take flat project fields rather than
 * a ProjectIntakeForm, and they don't need dry-run or service toggles.
 */

import { withRetry } from '../provisioner/retry'
import folderStructure from '../provisioner/folder-structure.json'
import { dropboxHeaders, getDropboxAccessToken } from '@/lib/dropbox/client'

// ─── Types ──────────────────────────────────────────────────

export interface ProvisionInput {
  projectName: string
  client: string
  projectCode?: string
  projectType?: string
  startDate?: string
  targetDelivery?: string
  briefSummary?: string
}

export interface ProvisionResult {
  id: string
  url: string
  name?: string
  extra?: Record<string, unknown>
}

// ─── Dropbox ────────────────────────────────────────────────

const DROPBOX_API = 'https://api.dropboxapi.com/2'

/**
 * Clone the Dropbox template folder into a new project folder.
 * Path: /Ranger & Fox/Production/{year}/{client}_{project}
 */
export async function provisionDropbox(input: ProvisionInput): Promise<ProvisionResult | null> {
  // Validate Dropbox creds via the centralized client (refresh-token or static)
  try {
    await getDropboxAccessToken()
  } catch (err: any) {
    console.warn('[Provision:Dropbox] Dropbox credentials not configured:', err.message)
    return null
  }

  const templatePath = process.env.DROPBOX_TEMPLATE_PATH ?? '/_TEMPLATES/New Project Template'
  const year = new Date().getFullYear()
  const slug = `${input.client}_${input.projectName}`.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_')
  const destPath = `/Ranger & Fox/Production/${year}/${slug}`

  try {
    // Copy template folder
    await withRetry(async () =>
      fetch(`${DROPBOX_API}/files/copy_v2`, {
        method: 'POST',
        headers: await dropboxHeaders(),
        body: JSON.stringify({
          from_path: templatePath,
          to_path: destPath,
          allow_ownership_transfer: false,
        }),
        signal: AbortSignal.timeout(8_000),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    )

    // Create a team-only shared link
    const linkRes = await withRetry(async () =>
      fetch(`${DROPBOX_API}/sharing/create_shared_link_with_settings`, {
        method: 'POST',
        headers: await dropboxHeaders(),
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          path: destPath,
          settings: { requested_visibility: 'team_only' },
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    )

    console.log(`[Provision:Dropbox] Created project folder: ${destPath}`)
    return {
      id: destPath,
      url: linkRes.url,
      name: slug,
    }
  } catch (err: any) {
    console.error('[Provision:Dropbox] Failed:', err.message)
    return null
  }
}

// ─── Frame.io ───────────────────────────────────────────────

const FRAMEIO_API = 'https://api.frame.io/v2'

function frameioHeaders() {
  return {
    Authorization: `Bearer ${process.env.FRAMEIO_TOKEN}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Create a Frame.io project with standard folder structure.
 */
export async function provisionFrameIo(input: ProvisionInput): Promise<ProvisionResult | null> {
  const token = process.env.FRAMEIO_TOKEN
  const teamId = process.env.FRAMEIO_TEAM_ID
  if (!token || !teamId) {
    console.warn('[Provision:FrameIo] FRAMEIO_TOKEN or FRAMEIO_TEAM_ID not set, skipping')
    return null
  }

  const projectLabel = input.projectCode
    ? `${input.projectCode}_${input.client}_${input.projectName}`
    : `${input.client}_${input.projectName}`

  try {
    // Create the project
    const project = await withRetry(() =>
      fetch(`${FRAMEIO_API}/projects`, {
        method: 'POST',
        headers: frameioHeaders(),
        body: JSON.stringify({ name: projectLabel, team_id: teamId }),
        signal: AbortSignal.timeout(8_000),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    )

    const projectId: string = project.id
    const rootAssetId: string = project.root_asset_id

    // Create standard subfolders in parallel
    const folders = folderStructure.frameio || []
    await Promise.allSettled(
      folders.map((folderName: string) =>
        withRetry(() =>
          fetch(`${FRAMEIO_API}/assets`, {
            method: 'POST',
            headers: frameioHeaders(),
            body: JSON.stringify({
              name: folderName,
              type: 'folder',
              parent_id: rootAssetId,
            }),
            signal: AbortSignal.timeout(8_000),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
          })
        )
      )
    )

    const url = `https://app.frame.io/projects/${projectId}`
    console.log(`[Provision:FrameIo] Created project: ${projectLabel} → ${url}`)
    return {
      id: projectId,
      url,
      name: projectLabel,
      extra: { rootAssetId, foldersCreated: folders.length },
    }
  } catch (err: any) {
    console.error('[Provision:FrameIo] Failed:', err.message)
    return null
  }
}
