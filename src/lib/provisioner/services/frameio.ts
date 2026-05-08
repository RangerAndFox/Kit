import { withRetry } from '../retry'
import type { ServiceResult, ProjectIntakeForm } from '../types'
import { buildProjectLabel } from '../types'
import { frameIoAuthHeaders } from '@/lib/frameio/auth'
import folderStructure from '../folder-structure.json'

const BASE_URL = 'https://api.frame.io/v4'

function unwrap(payload: any): any {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
}

export async function provisionFrameIo(
  form: ProjectIntakeForm,
  dryRun = false
): Promise<ServiceResult> {
  const accountId = process.env.FRAMEIO_ACCOUNT_ID ?? ''
  const workspaceId = process.env.FRAMEIO_WORKSPACE_ID ?? ''
  const label = buildProjectLabel(form)

  try {
    if (dryRun) {
      return { service: 'FrameIo', success: true, url: 'https://next.frame.io/project/dry-run' }
    }

    if (!accountId || !workspaceId) {
      throw new Error('FRAMEIO_ACCOUNT_ID and FRAMEIO_WORKSPACE_ID must be set')
    }

    const project = unwrap(
      await withRetry(async () => {
        const headers = await frameIoAuthHeaders()
        const r = await fetch(
          `${BASE_URL}/accounts/${accountId}/workspaces/${workspaceId}/projects`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ data: { name: label } }),
          }
        )
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    )

    const projectId: string = project.id
    const rootFolderId: string = project.root_folder_id || project.root_asset_id

    await Promise.allSettled(
      folderStructure.frameio.map((folderName) =>
        withRetry(async () => {
          const headers = await frameIoAuthHeaders()
          const r = await fetch(
            `${BASE_URL}/accounts/${accountId}/folders/${rootFolderId}/folders`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ data: { name: folderName } }),
            }
          )
          if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        })
      )
    )

    return {
      service: 'FrameIo',
      success: true,
      url: `https://next.frame.io/project/${projectId}`,
      id: projectId,
    }
  } catch (err) {
    return { service: 'FrameIo', success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
