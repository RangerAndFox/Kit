import { withRetry } from '../retry'
import { frameioHeaders } from '../../frameio/auth'
import type { ServiceResult, ProjectIntakeForm } from '../types'
import { buildProjectLabel } from '../types'
import folderStructure from '../folder-structure.json'

const BASE_URL = 'https://api.frame.io/v4'

export async function provisionFrameIo(
  form: ProjectIntakeForm,
  dryRun = false
): Promise<ServiceResult> {
  const accountId = process.env.FRAMEIO_ACCOUNT_ID ?? ''
  const workspaceId = process.env.FRAMEIO_WORKSPACE_ID ?? ''
  const label = buildProjectLabel(form)

  try {
    if (dryRun) {
      return { service: 'FrameIo', success: true, url: 'https://app.frame.io/projects/dry-run' }
    }

    // v4: POST /v4/accounts/{account_id}/workspaces/{workspace_id}/projects
    const projectResp = await withRetry(async () => {
      const hdrs = await frameioHeaders()
      return fetch(`${BASE_URL}/accounts/${accountId}/workspaces/${workspaceId}/projects`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ data: { name: label } }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    })

    const project = projectResp.data || projectResp
    const projectId: string = project.id
    const rootFolderId: string = project.root_folder_id || project.root_asset_id

    // v4: POST /v4/accounts/{account_id}/folders/{parent_id}/folders
    await Promise.allSettled(
      folderStructure.frameio.map((folderName) =>
        withRetry(async () => {
          const hdrs = await frameioHeaders()
          return fetch(`${BASE_URL}/accounts/${accountId}/folders/${rootFolderId}/folders`, {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify({ data: { name: folderName } }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
          })
        })
      )
    )

    return { service: 'FrameIo', success: true, url: `https://app.frame.io/projects/${projectId}`, id: projectId }
  } catch (err) {
    return { service: 'FrameIo', success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
