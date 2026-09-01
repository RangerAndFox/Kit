import type { BrowserContext, Locator, Page } from 'playwright-core'
import { config } from './config.js'
import { pulseFrameioDeletion, updateFrameioDeletion } from './store.js'
import type { FrameioProjectDeletionJob } from './types.js'

export class FrameioLoginRequiredError extends Error {}

export function validateFrameioDeletionJob(job: FrameioProjectDeletionJob): void {
  if (!/^[0-9a-f-]{36}$/i.test(job.frameio_project_id)) throw new Error('Frame.io deletion job has an invalid project id.')
  const url = new URL(job.frameio_project_url)
  if (url.protocol !== 'https:' || url.hostname !== 'next.frame.io' || !url.pathname.includes(job.frameio_project_id)) {
    throw new Error('Frame.io deletion job has an unsafe project URL.')
  }
  if (!job.frameio_project_name.trim()) throw new Error('Frame.io deletion job has no exact project name.')
}

async function signedOut(page: Page): Promise<boolean> {
  if (/adobe\.com.*signin|frame\.io\/.*(?:login|signin)/i.test(page.url())) return true
  const control = page.getByRole('button', { name: /^sign in$/i }).or(page.getByRole('link', { name: /^sign in$/i }))
  return await control.first().isVisible().catch(() => false)
}

export async function isFrameioSignedIn(context: BrowserContext): Promise<boolean> {
  const page = context.pages()[0] || await context.newPage()
  await page.goto(config.frameioStartUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1_500)
  if (await signedOut(page)) return false
  return await page.getByRole('button', { name: /^new project$/i }).first().isVisible().catch(() => false)
}

async function exactProjectRow(page: Page, name: string): Promise<Locator | null> {
  const candidates = page.getByTestId('project-row').filter({ hasText: name })
  const count = await candidates.count()
  const exact: Locator[] = []
  for (let index = 0; index < count; index += 1) {
    const row = candidates.nth(index)
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim()
    if (text.startsWith(name)) exact.push(row)
  }
  if (exact.length > 1) throw new Error(`Frame.io deletion is ambiguous: ${exact.length} rows match the exact project name.`)
  return exact[0] || null
}

export async function deleteFrameioProjectInBrowser(
  context: BrowserContext,
  job: FrameioProjectDeletionJob,
  signal?: AbortSignal,
): Promise<void> {
  validateFrameioDeletionJob(job)
  const page = await context.newPage()
  const abort = () => { void page.close().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    await updateFrameioDeletion(job, 'opening_project')
    await page.goto(config.frameioStartUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_500)
    if (await signedOut(page)) throw new FrameioLoginRequiredError('The dedicated studio browser is signed out of Frame.io. Run npm run login:frameio.')
    await pulseFrameioDeletion(job)

    const row = await exactProjectRow(page, job.frameio_project_name)
    if (!row) {
      // The server performs the authoritative API absence check before the Kit
      // project record can be deleted. A missing UI row is only a worker signal.
      await updateFrameioDeletion(job, 'complete', { error: null })
      return
    }

    await row.getByTestId('project-row--menu-button').click({ force: true })
    await page.getByRole('menuitem', { name: /^delete$/i }).click()
    const dialog = page.getByRole('alertdialog', { name: /delete project/i })
    await dialog.getByRole('textbox', { name: /type "delete" to confirm/i }).fill('delete')
    await updateFrameioDeletion(job, 'deleting')
    await dialog.getByRole('button', { name: /^delete project$/i }).click()
    await updateFrameioDeletion(job, 'verifying')
    await row.waitFor({ state: 'detached', timeout: 60_000 }).catch(async () => {
      if (await row.isVisible().catch(() => false)) throw new Error('Frame.io still shows the project after the deletion confirmation.')
    })
    await updateFrameioDeletion(job, 'complete', { error: null })
  } finally {
    signal?.removeEventListener('abort', abort)
    await page.close().catch(() => {})
  }
}
