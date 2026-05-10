import { withRetry } from '../retry'
import type { ServiceResult, ProjectIntakeForm } from '../types'
import { buildProjectLabel } from '../types'
import { dropboxHeaders } from '@/lib/dropbox/client'

const BASE_URL = 'https://api.dropboxapi.com/2'

/**
 * Copies the template folder to:
 *   /Ranger & Fox/Production/{year}/{number}_{client}_{project}
 */
export async function provisionDropbox(
  form: ProjectIntakeForm,
  dryRun = false
): Promise<ServiceResult> {
  const templatePath = process.env.DROPBOX_TEMPLATE_PATH ?? '/_TEMPLATES/New Project Template'
  const year = new Date().getFullYear()
  const label = buildProjectLabel(form)
  const destPath = `/Ranger & Fox/production/${year}/${label}`

  try {
    if (dryRun) {
      return { service: 'Dropbox', success: true, url: `https://dropbox.com/home${destPath}` }
    }

    await withRetry(async () =>
      fetch(`${BASE_URL}/files/copy_v2`, {
        method: 'POST',
        headers: await dropboxHeaders(),
        body: JSON.stringify({ from_path: templatePath, to_path: destPath, allow_ownership_transfer: false }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    )

    const linkRes = await withRetry(async () =>
      fetch(`${BASE_URL}/sharing/create_shared_link_with_settings`, {
        method: 'POST',
        headers: await dropboxHeaders(),
        body: JSON.stringify({ path: destPath, settings: { requested_visibility: 'team_only' } }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        return r.json()
      })
    )

    return { service: 'Dropbox', success: true, url: linkRes.url }
  } catch (err) {
    return { service: 'Dropbox', success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
