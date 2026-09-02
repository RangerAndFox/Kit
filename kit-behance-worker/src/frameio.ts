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

type FrameioProjectControl = {
  container: Locator
  menuButton: Locator
}

async function exactProjectControl(
  page: Page,
  projectId: string,
  name: string,
): Promise<FrameioProjectControl | null> {
  // Frame.io persists each user's preferred home layout. The dedicated worker
  // may therefore see either the table (`project-row`) or card
  // (`project-card`) variant. Cards expose the provider id in their href, which
  // is the strongest possible identity signal and must take precedence over a
  // mutable/duplicate display name.
  const projectPath = `/project/${projectId}`
  const cards = page.locator(`[data-testid="project-card"][href="${projectPath}"]`)
  if (await cards.count()) {
    const card = cards.first()
    return { container: card, menuButton: card.getByTestId('project-card--menu-button') }
  }

  const candidates = page.getByTestId('project-row').filter({ hasText: name })
  const count = await candidates.count()
  const exact: Locator[] = []
  for (let index = 0; index < count; index += 1) {
    const row = candidates.nth(index)
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim()
    if (text.startsWith(name)) exact.push(row)
  }
  if (exact.length > 1) throw new Error(`Frame.io deletion is ambiguous: ${exact.length} rows match the exact project name.`)
  const row = exact[0]
  return row ? { container: row, menuButton: row.getByTestId('project-row--menu-button') } : null
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

    const project = await exactProjectControl(page, job.frameio_project_id, job.frameio_project_name)
    if (!project) {
      // The server performs the authoritative API absence check before the Kit
      // project record can be deleted. A missing UI row is only a worker signal.
      await updateFrameioDeletion(job, 'complete', { error: null })
      return
    }

    await project.menuButton.click({ force: true })
    await page.getByRole('menuitem', { name: /^delete$/i }).click()
    const dialog = page.getByRole('alertdialog', { name: /delete project/i })
    await dialog.getByRole('textbox', { name: /type "delete" to confirm/i }).fill('delete')
    await updateFrameioDeletion(job, 'deleting')
    await dialog.getByRole('button', { name: /^delete project$/i }).click()
    await updateFrameioDeletion(job, 'verifying')
    await project.container.waitFor({ state: 'detached', timeout: 60_000 }).catch(async () => {
      if (await project.container.isVisible().catch(() => false)) throw new Error('Frame.io still shows the project after the deletion confirmation.')
    })
    await updateFrameioDeletion(job, 'complete', { error: null })
  } finally {
    signal?.removeEventListener('abort', abort)
    await page.close().catch(() => {})
  }
}
