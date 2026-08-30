import type { BrowserContext, Locator, Page } from 'playwright-core'
import { config } from './config.js'
import { pulseElevenLabsJob, updateElevenLabsJob } from './store.js'
import type { ElevenLabsStudioJob } from './types.js'

export class ElevenLabsLoginRequiredError extends Error {}

async function visible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible().catch(() => false)) return candidate
    }
  }
  return null
}

async function waitVisible(locators: Locator[], timeoutMs = 30_000): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  do {
    const match = await visible(locators)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  return null
}

export function parseStudioProject(urlValue: string): { projectId: string; url: string } {
  const url = new URL(urlValue)
  if (!/(^|\.)elevenlabs\.io$/i.test(url.hostname)) throw new Error('ElevenLabs returned an unsafe project URL.')
  const match = url.pathname.match(/^\/app\/studio\/([^/?#]+)/i)
  if (!match) throw new Error('ElevenLabs opened Studio but returned no project id.')
  return { projectId: decodeURIComponent(match[1]), url: url.toString() }
}

async function installDraftLockout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      const control = target?.closest('button,a,[role="button"]') as HTMLElement | null
      const label = `${control?.innerText || ''} ${control?.getAttribute('aria-label') || ''}`.trim()
      if (/^(generate|export|publish|share)(\s|$)/i.test(label)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }, true)
  })
}

export async function isElevenLabsSignedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage()
  try {
    await installDraftLockout(page)
    await page.goto(config.elevenLabsStartUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_500)
    if (/\/(sign-in|login)(?:[/?#]|$)/i.test(page.url())) return false
    const signedOut = await visible([
      page.getByRole('button', { name: /sign in|log in/i }),
      page.getByRole('link', { name: /sign in|log in/i }),
    ])
    return !signedOut && Boolean(await visible([
      page.getByRole('button', { name: /new blank project/i }),
      page.getByText(/studio/i),
    ]))
  } finally {
    await page.close().catch(() => {})
  }
}

async function findExisting(page: Page, name: string): Promise<string | null> {
  const links = page.locator('a[href^="/app/studio/"]')
  const count = await links.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index)
    const text = (await link.innerText().catch(() => '')).trim()
    if (text.split('\n')[0].trim().toLowerCase() === name.toLowerCase()) return link.getAttribute('href')
  }
  return null
}

export async function buildElevenLabsDraft(
  context: BrowserContext,
  job: ElevenLabsStudioJob,
  signal?: AbortSignal,
): Promise<{ projectId: string; url: string }> {
  const page = await context.newPage()
  const abort = () => { void page.close().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    await installDraftLockout(page)
    await updateElevenLabsJob(job, 'opening_studio')
    const resumableUrl = job.studio_url && /^https:\/\/elevenlabs\.io\/app\/studio\//i.test(job.studio_url)
      ? job.studio_url
      : null
    await page.goto(resumableUrl || config.elevenLabsStartUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_500)
    if (/\/(sign-in|login)(?:[/?#]|$)/i.test(page.url())) {
      throw new ElevenLabsLoginRequiredError('The dedicated studio browser is signed out of ElevenLabs. Run npm run login:elevenlabs.')
    }

    if (!resumableUrl) {
      const existing = await findExisting(page, job.project_name)
      if (existing) {
        await page.goto(new URL(existing, 'https://elevenlabs.io').toString(), { waitUntil: 'domcontentloaded' })
        return parseStudioProject(page.url())
      }

      const newProject = await waitVisible([
        page.getByRole('button', { name: /new blank project/i }),
        page.getByText(/new blank project/i),
      ])
      if (!newProject) throw new Error('ElevenLabs Studio changed: New blank project was not found.')
      await newProject.click()
      const audioProject = await waitVisible([
        page.getByRole('button', { name: /audio project/i }),
        page.getByText(/^audio project$/i),
      ])
      if (!audioProject) throw new Error('ElevenLabs Studio changed: Audio project was not found.')
      await audioProject.click()
      await page.waitForURL(/\/app\/studio\/[^/?#]+/i, { timeout: 60_000 })
      const checkpoint = parseStudioProject(page.url())
      await updateElevenLabsJob(job, 'opening_studio', {
        studio_project_id: checkpoint.projectId,
        studio_url: checkpoint.url,
      })
    } else {
      await page.waitForURL(/\/app\/studio\/[^/?#]+/i, { timeout: 60_000 })
    }
    await pulseElevenLabsJob(job)

    await updateElevenLabsJob(job, 'filling_project')
    const editName = await waitVisible([
      page.getByRole('button', { name: /edit field/i }),
      page.locator('[aria-label*="edit field" i]'),
    ], 45_000)
    if (!editName) throw new Error('ElevenLabs Studio changed: project name editor was not found.')
    await editName.click()
    const nameInput = await waitVisible([
      page.getByPlaceholder(/untitled/i),
      page.locator('input').last(),
    ])
    if (!nameInput) throw new Error('ElevenLabs Studio changed: project name input was not found.')
    await nameInput.fill(job.project_name)
    await nameInput.press('Enter')

    const editor = await waitVisible([
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ], 45_000)
    if (!editor) throw new Error('ElevenLabs Studio changed: voiceover editor was not found.')
    const paragraphs = Array.isArray(job.voiceover_paragraphs)
      ? job.voiceover_paragraphs.map(String).map((value) => value.trim()).filter(Boolean)
      : []
    if (!paragraphs.length) throw new Error('The ElevenLabs job contains no voiceover.')
    // ElevenLabs only turns explicit Enter keystrokes into separate speech
    // clips. Filling a newline-delimited string silently keeps the first clip
    // and discards the rest, so create each paragraph through the editor's
    // normal input path and verify every clip before declaring success.
    await editor.fill(paragraphs[0])
    for (const paragraph of paragraphs.slice(1)) {
      await editor.press('End')
      await editor.press('Enter')
      await page.keyboard.insertText(paragraph)
    }
    for (const paragraph of paragraphs) {
      const rendered = await waitVisible([page.getByText(paragraph, { exact: true })], 30_000)
      if (!rendered) throw new Error('ElevenLabs Studio did not retain every voiceover paragraph.')
    }

    await updateElevenLabsJob(job, 'saving_draft')
    await page.waitForTimeout(2_500)
    await pulseElevenLabsJob(job)
    return parseStudioProject(page.url())
  } finally {
    signal?.removeEventListener('abort', abort)
    await page.close().catch(() => {})
  }
}
