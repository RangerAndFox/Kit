import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { config } from './config.js'
import { downloadFiles, uploadProof } from './dropbox.js'
import { installPublishLockout } from './safety.js'
import { behanceContentModules } from './layout.js'
import { pulseJob, updateJob } from './store.js'
import type { BehanceDraftJob, BehanceTextRole } from './types.js'
import { behanceIdentityError, behanceProfileSlugFromHref, behanceUsernameFromState, type BehanceIdentity } from './behance-identity.js'

export { behanceIdentityError } from './behance-identity.js'

export class BehanceLoginRequiredError extends Error {}

async function profileSlug(page: Page): Promise<string | null> {
  const links = await page.locator('a[href]').all()
  for (const link of links) {
    const label = `${await link.innerText().catch(() => '')} ${await link.getAttribute('aria-label').catch(() => '')}`
    if (!/profile|user options/i.test(label)) continue
    const slug = behanceProfileSlugFromHref(await link.getAttribute('href').catch(() => null))
    if (slug) return slug
  }
  const state = (await page.locator('script').allTextContents().catch(() => [])).join('\n')
  return behanceUsernameFromState(state)
}

export async function inspectBehanceIdentity(context: BrowserContext): Promise<BehanceIdentity> {
  const page = context.pages()[0] || await context.newPage()
  await page.goto('https://www.behance.net/settings', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1_500)
  const url = page.url()
  const signedOut = /adobe\.com.*signin|behance\.net\/.*(?:login|signin)/i.test(url) || Boolean(await visible([
    page.getByRole('button', { name: /^sign in$/i }),
    page.getByRole('link', { name: /^sign in$/i }),
  ]))
  return {
    signedIn: !signedOut,
    profileSlug: signedOut ? null : await profileSlug(page),
    expectedProfileSlug: config.expectedProfileSlug,
  }
}

export async function assertExpectedBehanceIdentity(context: BrowserContext): Promise<void> {
  const error = behanceIdentityError(await inspectBehanceIdentity(context))
  if (error) throw new BehanceLoginRequiredError(error)
}

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

async function waitActionable(locators: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  do {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0)
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index)
        if (await candidate.isVisible().catch(() => false)
          && await candidate.isEnabled().catch(() => false)) return candidate
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
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

export function isReusableBehanceDraftUrl(value?: string | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return /(^|\.)behance\.net$/i.test(url.hostname)
      && /\/(?:portfolio|gallery)\/editor\/?$/i.test(url.pathname)
      && Boolean(url.searchParams.get('project_id'))
  } catch {
    return false
  }
}

async function openEditor(page: Page, existingUrl?: string | null): Promise<void> {
  if (isReusableBehanceDraftUrl(existingUrl)) {
    await page.goto(existingUrl!, { waitUntil: 'domcontentloaded' })
    return
  }
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' })
  const share = await visible([
    page.getByRole('button', { name: /^share your work$/i }),
    page.getByRole('link', { name: /^share your work$/i }),
    page.getByRole('link', { name: /^share work$/i }),
    page.getByRole('button', { name: /^open share your work options$/i }),
    page.getByRole('button', { name: /^create$/i }),
  ])
  if (!share) throw new Error('Behance editor changed: could not find the Share Work control.')
  await share.click()
  await page.waitForTimeout(700)

  // Behance's current Share Work button opens a new project editor directly.
  // Older versions opened a menu first, so retain the Project-menu fallback.
  const editorReady = await visible([
    page.getByRole('button', { name: /^text$/i }),
    page.getByRole('button', { name: /^image$/i }),
    page.getByRole('button', { name: /^save as draft$/i }),
  ])
  if (!editorReady) {
    await clickRequired([
      page.getByRole('menuitem', { name: /^project$/i }),
      page.getByRole('link', { name: /^project$/i }),
      page.getByRole('button', { name: /^project$/i }),
    ], 'the Project creation option')
  }
  await page.waitForTimeout(1500)
  if (/adobe\.com.*signin|behance\.net\/.*(?:login|signin)/i.test(page.url())) throw new BehanceLoginRequiredError('The dedicated Behance browser profile is signed out. Run `npm run login` on the studio Mac.')
  const ownershipWarning = page.getByText(/only owners can modify projects/i)
  if (await ownershipWarning.isVisible().catch(() => false)) {
    // Behance occasionally opens an editor with a stale authorization result.
    // One clean reload refreshes the IMS check without changing the draft.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3_000)
    if (await ownershipWarning.isVisible().catch(() => false)) {
      throw new BehanceLoginRequiredError('Behance rejected this editor session even though Kit is signed in. Re-authenticate the dedicated @rangerandfox profile before retrying the draft.')
    }
  }
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

async function addTextModule(page: Page, text: string, role: BehanceTextRole): Promise<void> {
  if (!text) return
  const control = await visible([
    page.getByRole('button', { name: /^(add )?text$/i }),
    page.getByText(/^text$/i),
  ])
  if (!control) throw new Error(`Behance editor changed: could not add the ${role} text module.`)
  await control.click()
  const editor = await visible([
    page.locator('[contenteditable="true"]').last(),
    page.locator('textarea').last(),
  ])
  if (!editor) throw new Error(`Behance editor changed: could not find the ${role} text editor.`)
  if (await editor.getAttribute('contenteditable') === 'true') await editor.fill(text)
  else await editor.fill(text)
  // Ranger & Fox portfolio copy uses centered text modules. Alignment is a
  // presentation enhancement, so an editor-label change must not discard the
  // approved copy; missing content controls above remain terminal.
  const center = await visible([
    page.getByRole('button', { name: /^(align )?center$/i }),
    page.locator('[aria-label*="align center" i], [title*="align center" i]'),
  ])
  if (center) await center.click().catch(() => {})
  const done = await visible([
    page.getByRole('button', { name: /^(done|save)$/i }),
  ])
  if (done) await done.click()
  else await editor.press('Escape').catch(() => {})
  await page.waitForTimeout(150)
}

async function fillDetails(page: Page, job: BehanceDraftJob, coverPath: string): Promise<void> {
  const manifest = job.manifest
  await fillFirst([
    page.getByLabel(/project title/i),
    page.getByPlaceholder(/project title/i),
    page.locator('input[name*="title" i]'),
  ], manifest.title)

  const description = manifest.excerpt || manifest.descriptions[0] || manifest.subtitle || ''
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
  // Behance autosaves settings first and temporarily replaces both draft
  // buttons with “Saving…”. Wait for the real draft action to return.
  const draft = await waitActionable([
    page.getByLabel(/^settings action buttons$/i).getByRole('button', { name: /^save as draft$/i }),
    page.getByRole('button', { name: /^save as draft$/i }),
    page.getByRole('button', { name: /^save draft$/i }),
    page.getByRole('button', { name: /^save$/i }),
  ], 60_000)
  if (!draft) throw new Error('Behance editor changed: could not find the Save Draft control.')
  await draft.click()
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

export async function isBehanceSignedIn(context: BrowserContext): Promise<boolean> {
  return behanceIdentityError(await inspectBehanceIdentity(context)) === null
}

export async function behanceBrowserVersion(context: BrowserContext): Promise<string | null> {
  const direct = context.browser()?.version()
  if (direct) return direct
  const page = context.pages()[0] || await context.newPage()
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '')
  return userAgent.match(/Chrome\/([\d.]+)/)?.[1] || null
}

export async function buildBehanceDraft(context: BrowserContext, job: BehanceDraftJob, signal?: AbortSignal): Promise<{ draftUrl: string; proofPath: string; proofUrl: string | null }> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `kit-behance-${job.id}-`))
  const page = await context.newPage()
  const abort = () => { void page.close().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  await installPublishLockout(page)
  try {
    await assertExpectedBehanceIdentity(context)
    await updateJob(job, 'opening_editor')
    await openEditor(page, job.draft_url)
    // Persist the editor location before any upload. If the process stops,
    // the retry returns to this draft instead of creating a duplicate.
    await updateJob(job, 'opening_editor', { draft_url: page.url() })
    await pulseJob(job)

    const localMedia = await downloadFiles(job.manifest.media, temp)
    const localByCloudPath = new Map(job.manifest.media.map((cloudPath, index) => [cloudPath, localMedia[index]]))
    await updateJob(job, 'uploading_media')
    for (const module of behanceContentModules(job.manifest)) {
      if (module.kind === 'text') {
        await addTextModule(page, module.text, module.role)
      } else {
        const paths = module.paths.map((cloudPath) => localByCloudPath.get(cloudPath)).filter((item): item is string => Boolean(item))
        if (paths.length !== module.paths.length) throw new Error('The Behance layout referenced media outside the approved package.')
        await uploadProjectMedia(page, paths)
      }
      await pulseJob(job)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(300)
    await clickRequired([
      page.getByRole('button', { name: /^continue$/i }),
      page.getByRole('button', { name: /^(edit )?settings$/i }),
      page.getByLabel(/^edit settings$/i),
    ], 'Continue or Settings')

    await updateJob(job, 'filling_details')
    await fillDetails(page, job, localMedia[0])
    await updateJob(job, 'saving_draft')
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
    signal?.removeEventListener('abort', abort)
    await page.close().catch(() => {})
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}
