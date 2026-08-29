import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { config } from './config.js'
import { downloadFiles, uploadProof } from './dropbox.js'
import { installPublishLockout } from './safety.js'
import { pulseJob, updateJob } from './store.js'
import type { BehanceDraftJob } from './types.js'

export class BehanceLoginRequiredError extends Error {}

async function visible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const first = locator.first()
    if (await first.isVisible().catch(() => false)) return first
  }
  return null
}

async function clickRequired(locators: Locator[], description: string): Promise<void> {
  const target = await visible(locators)
  if (!target) throw new Error(`Behance editor changed: could not find ${description}.`)
  const label = (await target.innerText().catch(() => '')) || (await target.getAttribute('aria-label').catch(() => '')) || ''
  if (/publish/i.test(label)) throw new Error(`Safety lockout refused a publish-like control while looking for ${description}.`)
  await target.click()
}

async function fillFirst(locators: Locator[], value: string): Promise<boolean> {
  if (!value) return false
  const target = await visible(locators)
  if (!target) return false
  await target.fill(value)
  return true
}

async function openEditor(page: Page, existingUrl?: string | null): Promise<void> {
  if (existingUrl?.startsWith('https://www.behance.net/')) {
    await page.goto(existingUrl, { waitUntil: 'domcontentloaded' })
    return
  }
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' })
  const share = await visible([
    page.getByRole('button', { name: /^share your work$/i }),
    page.getByRole('link', { name: /^share your work$/i }),
    page.getByRole('button', { name: /^create$/i }),
  ])
  if (share) {
    await share.click()
    await clickRequired([
      page.getByRole('menuitem', { name: /^project$/i }),
      page.getByRole('link', { name: /^project$/i }),
      page.getByRole('button', { name: /^project$/i }),
    ], 'the Project creation option')
  } else {
    await page.goto('https://www.behance.net/gallery/editor', { waitUntil: 'domcontentloaded' })
  }
  await page.waitForTimeout(1500)
  if (/adobe\.com.*signin|behance\.net\/.*(?:login|signin)/i.test(page.url())) throw new BehanceLoginRequiredError('The dedicated Behance browser profile is signed out. Run `npm run login` on the studio Mac.')
}

async function uploadProjectMedia(page: Page, paths: string[]): Promise<void> {
  if (!paths.length) throw new Error('The Behance package contains no media.')
  const directInput = await visible([
    page.locator('input[type="file"][multiple]'),
    page.locator('input[type="file"][accept*="image"]'),
  ])
  if (directInput) {
    await directInput.setInputFiles(paths)
  } else {
    const chooserPromise = page.waitForEvent('filechooser')
    await clickRequired([
      page.getByRole('button', { name: /^(add )?image(s)?$/i }),
      page.getByText(/^image$/i),
    ], 'the image upload control')
    const chooser = await chooserPromise
    await chooser.setFiles(paths)
  }
  await page.waitForLoadState('networkidle', { timeout: 180_000 }).catch(() => {})
}

async function addTextModule(page: Page, text: string): Promise<boolean> {
  if (!text) return false
  const control = await visible([
    page.getByRole('button', { name: /^(add )?text$/i }),
    page.getByText(/^text$/i),
  ])
  if (!control) return false
  await control.click()
  const editor = await visible([
    page.locator('[contenteditable="true"]').last(),
    page.locator('textarea').last(),
  ])
  if (!editor) return false
  if (await editor.getAttribute('contenteditable') === 'true') await editor.fill(text)
  else await editor.fill(text)
  const done = await visible([
    page.getByRole('button', { name: /^(done|save|add text)$/i }),
  ])
  if (done) await done.click()
  return true
}

async function fillDetails(page: Page, job: BehanceDraftJob, coverPath: string): Promise<void> {
  const manifest = job.manifest
  await fillFirst([
    page.getByLabel(/project title/i),
    page.getByPlaceholder(/project title/i),
    page.locator('input[name*="title" i]'),
  ], manifest.title)

  const description = [manifest.subtitle, ...manifest.descriptions, manifest.credits && `Credits\n${manifest.credits}`].filter(Boolean).join('\n\n')
  await fillFirst([
    page.getByLabel(/project description/i),
    page.getByPlaceholder(/project description/i),
    page.locator('textarea[name*="description" i]'),
  ], description)

  const coverInput = await visible([
    page.locator('input[type="file"][accept*="image"]'),
    page.getByLabel(/cover image/i).locator('input[type="file"]'),
  ])
  if (coverInput) await coverInput.setInputFiles(coverPath)

  const creativeField = await visible([
    page.getByLabel(/creative field/i),
    page.getByRole('combobox', { name: /creative field/i }),
    page.getByText(/select creative field/i),
  ])
  if (creativeField) {
    await creativeField.click()
    const option = await visible([
      page.getByRole('option', { name: new RegExp(`^${config.creativeField}$`, 'i') }),
      page.getByText(new RegExp(`^${config.creativeField}$`, 'i')),
    ])
    if (option) await option.click()
  }

  const tags = [...new Set(manifest.tags)].slice(0, 10)
  const tagInput = await visible([
    page.getByLabel(/project tags/i),
    page.getByPlaceholder(/(?:add|project) tags/i),
    page.locator('input[name*="tag" i]'),
  ])
  if (tagInput) {
    for (const tag of tags) {
      await tagInput.fill(tag)
      await tagInput.press('Enter')
    }
  }
}

async function saveDraft(page: Page): Promise<void> {
  await clickRequired([
    page.getByRole('button', { name: /^save as draft$/i }),
    page.getByRole('button', { name: /^save draft$/i }),
    page.getByRole('button', { name: /^save$/i }),
  ], 'the Save Draft control')
  await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {})
}

export async function launchBehanceContext(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    executablePath: config.chromePath,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
  })
  return context
}

export async function buildBehanceDraft(context: BrowserContext, job: BehanceDraftJob): Promise<{ draftUrl: string; proofPath: string; proofUrl: string | null }> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `kit-behance-${job.id}-`))
  const page = await context.newPage()
  await installPublishLockout(page)
  try {
    await updateJob(job.id, 'opening_editor')
    await openEditor(page, job.draft_url)
    // Persist the editor location before any upload. If the process stops,
    // the retry returns to this draft instead of creating a duplicate.
    await updateJob(job.id, 'opening_editor', { draft_url: page.url() })
    await pulseJob(job.id)

    const localMedia = await downloadFiles(job.manifest.media, temp)
    await updateJob(job.id, 'uploading_media')
    await uploadProjectMedia(page, localMedia)

    const text = [job.manifest.subtitle, ...job.manifest.descriptions, job.manifest.credits && `Credits\n${job.manifest.credits}`].filter(Boolean).join('\n\n')
    await addTextModule(page, text).catch(() => false)
    await clickRequired([
      page.getByRole('button', { name: /^continue$/i }),
      page.getByRole('button', { name: /^settings$/i }),
    ], 'Continue or Settings')

    await updateJob(job.id, 'filling_details')
    await fillDetails(page, job, localMedia[0])
    await updateJob(job.id, 'saving_draft')
    await saveDraft(page)

    const draftUrl = page.url()
    if (!draftUrl.startsWith('https://www.behance.net/')) throw new Error('Behance saved the draft but did not return a safe Behance review URL.')
    const screenshot = path.join(temp, 'behance-draft-proof.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    const proof = job.manifest.archiveFolderPath
      ? await uploadProof(screenshot, job.manifest.archiveFolderPath)
      : { path: '', url: null }
    return { draftUrl, proofPath: proof.path, proofUrl: proof.url }
  } finally {
    await page.close().catch(() => {})
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}
