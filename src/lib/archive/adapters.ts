// @ts-nocheck
import { getDropboxTemporaryLink, type DropboxArchiveFile } from './dropbox'
import type { ArchiveJob } from './types'
import { archiveFolderName } from './types'

const fetchJson = async (url: string, init: RequestInit, timeoutMs = 30_000): Promise<any> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}: ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : {}
}

export function configuredArchiveDestinations(env: Record<string, string | undefined> = process.env): Array<'dropbox' | 'vimeo' | 'wordpress' | 'buffer' | 'behance'> {
  if (env.KIT_ARCHIVE_DESTINATIONS) {
    const allowed = new Set(['dropbox', 'vimeo', 'wordpress', 'buffer', 'behance'])
    const configured = env.KIT_ARCHIVE_DESTINATIONS
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is 'dropbox' | 'vimeo' | 'wordpress' | 'buffer' | 'behance' => allowed.has(value))
    return [...new Set(configured)]
  }
  const result: Array<'dropbox' | 'vimeo' | 'wordpress' | 'buffer' | 'behance'> = ['dropbox']
  if (env.VIMEO_ACCESS_TOKEN) result.push('vimeo')
  if (env.WORDPRESS_SITE_URL && env.WORDPRESS_USERNAME && env.WORDPRESS_APP_PASSWORD) result.push('wordpress')
  if (env.BUFFER_ACCESS_TOKEN && (env.BUFFER_LINKEDIN_CHANNEL_ID || env.BUFFER_INSTAGRAM_CHANNEL_ID)) result.push('buffer')
  result.push('behance')
  return result
}

export async function createUnlistedVimeo(job: ArchiveJob, videoPath: string, size: number): Promise<any> {
  const token = process.env.VIMEO_ACCESS_TOKEN
  if (!token) throw new Error('Vimeo is not configured in Kit.')
  const link = await getDropboxTemporaryLink(videoPath)
  // Vimeo's pull approach lets Vimeo ingest directly from Dropbox, avoiding a
  // giant video buffer in Kit and preserving resumability at the provider edge.
  const created = await fetchJson('https://api.vimeo.com/me/videos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.vimeo.*+json;version=3.4' },
    body: JSON.stringify({
      upload: { approach: 'pull', link, size },
      name: job.settings.title,
      description: [job.settings.description1, job.settings.description2, job.settings.description3].filter(Boolean).join('\n\n'),
      privacy: { view: 'unlisted' },
    }),
  }, 60_000)
  const id = String(created.uri || '').split('/').pop()
  if (!id) throw new Error('Vimeo created the upload but returned no video id.')
  return { status: 'unlisted', id, url: created.link || `https://vimeo.com/${id}` }
}

function wordpressHeaders(): Record<string, string> {
  const username = process.env.WORDPRESS_USERNAME
  const password = process.env.WORDPRESS_APP_PASSWORD
  if (!username || !password) throw new Error('WordPress credentials are not configured in Kit.')
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, 'Content-Type': 'application/json' }
}

async function uploadWordpressMedia(file: DropboxArchiveFile): Promise<{ id: number; url?: string; fileName: string }> {
  const sourceUrl = await getDropboxTemporaryLink(file.path)
  const source = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) })
  if (!source.ok) throw new Error(`Could not download ${file.name} from Dropbox for WordPress.`)
  const bytes = Buffer.from(await source.arrayBuffer())
  const ext = file.name.split('.').pop()?.toLowerCase()
  const contentType = ext === 'gif' ? 'image/gif' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  const response = await fetch(`${wpBase()}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      ...wordpressHeaders(),
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${file.name.replace(/["\\]/g, '_')}"`,
    },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.id) throw new Error(`WordPress media upload failed for ${file.name}: ${body.message || response.status}`)
  return { id: Number(body.id), url: body.source_url, fileName: file.name }
}

function updatePortfolioModules(modules: any[], job: ArchiveJob, uploadedMain: Array<{ id: number }>, uploadedProcess: Array<{ id: number }>): any[] {
  let output = structuredClone(modules || [])
  let article = 0
  for (const module of output) {
    if (module?.acf_fc_layout === 'article') {
      article++
      if (article === 1 && job.settings.description2) module.body_text = `<p>${job.settings.description2}</p>`
      if (article === 2 && job.settings.description3) module.body_text = `<p>${job.settings.description3}</p>`
    }
    if (module?.acf_fc_layout === 'accordion' && job.settings.credits) {
      module.body_text = job.settings.credits.split(/\r?\n/).filter(Boolean).map((line) => {
        const [label, ...rest] = line.split(':')
        return rest.length ? `<strong>${label.trim()}:</strong> ${rest.join(':').trim()}` : line
      }).join('<br>')
    }
  }
  let marquee = output.findIndex((module) => module?.acf_fc_layout === 'marquee')
  let accordion = output.findIndex((module) => module?.acf_fc_layout === 'accordion')
  const mainEnd = marquee >= 0 ? marquee : accordion >= 0 ? accordion : output.length
  const mainSlots = output.map((module, index) => module?.acf_fc_layout === 'image_embed' && index < mainEnd ? index : -1).filter((index) => index >= 0)
  mainSlots.slice(0, uploadedMain.length).forEach((slot, index) => {
    output[slot].images = [{ individual_image: uploadedMain[index].id, optional_caption: '', optional_link: '' }]
  })

  marquee = output.findIndex((module) => module?.acf_fc_layout === 'marquee')
  accordion = output.findIndex((module) => module?.acf_fc_layout === 'accordion')
  if (!job.settings.includeProcess && marquee >= 0 && accordion > marquee) {
    output.splice(marquee, accordion - marquee)
  } else if (job.settings.includeProcess && marquee >= 0 && uploadedProcess.length) {
    const processEnd = accordion >= 0 ? accordion : output.length
    const slots = output.map((module, index) => module?.acf_fc_layout === 'image_embed' && index > marquee && index < processEnd ? index : -1).filter((index) => index >= 0)
    slots.slice(0, uploadedProcess.length).forEach((slot, index) => {
      output[slot].images = [{ individual_image: uploadedProcess[index].id, optional_caption: '', optional_link: '' }]
    })
    for (const slot of slots.slice(uploadedProcess.length).reverse()) output.splice(slot, 1)
  }
  return output
}

const wpBase = () => {
  const site = process.env.WORDPRESS_SITE_URL
  if (!site) throw new Error('WordPress site URL is not configured in Kit.')
  return site.replace(/\/$/, '')
}

export async function createWordpressDraft(job: ArchiveJob, vimeo: any | null, media: DropboxArchiveFile[]): Promise<any> {
  const templateId = process.env.WORDPRESS_TEMPLATE_POST_ID || '6343'
  const slug = job.settings.title.normalize('NFKD').replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
  const duplicated = await fetchJson(`${wpBase()}/wp-json/rf/v1/duplicate-work/${templateId}`, {
    method: 'POST', headers: wordpressHeaders(), body: JSON.stringify({ title: job.settings.title, slug }),
  })
  const postId = duplicated.new_post_id || duplicated.post_id || duplicated.id
  if (!postId) throw new Error('WordPress returned no draft post id.')

  const mainCandidates = media.filter((item) => !/\/Process\//i.test(item.path))
  const hero = mainCandidates.find((item) => !/\.gif$/i.test(item.name))
  const gifs = mainCandidates.filter((item) => /\.gif$/i.test(item.name)).slice(0, 8)
  const processCandidates = job.settings.includeProcess ? media.filter((item) => /\/Process\//i.test(item.path)).slice(0, 8) : []
  const uploadedMain = []
  for (const item of [hero, ...gifs].filter(Boolean)) uploadedMain.push(await uploadWordpressMedia(item))
  const uploadedProcess = []
  for (const item of processCandidates) uploadedProcess.push(await uploadWordpressMedia(item))

  const current = await fetchJson(`${wpBase()}/wp-json/rf/v1/work/${postId}/acf-fields`, { method: 'GET', headers: wordpressHeaders() })
  const pageModules = updatePortfolioModules(current?.fields?.page_modules || [], job, uploadedMain, uploadedProcess)
  const fields = {
    title: job.settings.title,
    slug,
    excerpt: job.settings.excerpt,
    featured_image: uploadedMain[0]?.id || null,
    acf: {
      project_subtitle: job.settings.subtitle,
      description: job.settings.description1 ? `<p>${job.settings.description1}</p>` : '',
      primary_vimeo_embed: vimeo?.id || null,
      meta: [
        { label: 'Year:', value: job.settings.year },
        { label: 'Services:', value: job.settings.services.join('\n') },
      ],
      ...(uploadedMain[0]?.id ? { hero_image: uploadedMain[0].id } : {}),
      ...(job.settings.backgroundColor.startsWith('#') ? { custom_background_colour: job.settings.backgroundColor } : {}),
      ...(pageModules.length ? { page_modules: pageModules } : {}),
    },
  }
  await fetchJson(`${wpBase()}/wp-json/rf/v1/work/${postId}/update-fields`, {
    method: 'POST', headers: wordpressHeaders(), body: JSON.stringify(fields),
  })
  return { status: 'draft', id: String(postId), editUrl: duplicated.edit_url || `${wpBase()}/wp-admin/post.php?post=${postId}&action=edit`, mediaUploaded: uploadedMain.length + uploadedProcess.length }
}

export async function createBufferDrafts(job: ArchiveJob, vimeo: any | null): Promise<any> {
  const token = process.env.BUFFER_ACCESS_TOKEN
  const apiUrl = process.env.BUFFER_API_URL || 'https://api.buffer.com/'
  if (!token) throw new Error('Buffer is not configured in Kit.')
  const channels = [
    ['linkedin', process.env.BUFFER_LINKEDIN_CHANNEL_ID],
    ['instagram', process.env.BUFFER_INSTAGRAM_CHANNEL_ID],
  ].filter(([, id]) => id)
  if (!channels.length) throw new Error('Buffer has no configured LinkedIn or Instagram channel.')
  const text = job.settings.socialCopy || [job.settings.description1, job.settings.description2].filter(Boolean).join('\n\n')
  const drafts = []
  for (const [name, channelId] of channels) {
    // Buffer's current CreatePostInput requires an explicit scheduling type and
    // share mode even when the post is saved as a draft. `saveToDraft` remains
    // the safeguard that prevents either value from scheduling or publishing.
    const input = {
      channelId,
      text,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      source: 'kit-archive',
      ...(name === 'instagram'
        ? { metadata: { instagram: { type: 'post', shouldShareToFeed: true } } }
        : {}),
    }
    const response = await fetchJson(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id status } } ... on InvalidInputError { message } ... on LimitReachedError { message } } }', variables: { input } }),
    })
    const post = response?.data?.createPost?.post
    if (!post?.id) throw new Error(`Buffer did not create the ${name} draft: ${response?.data?.createPost?.message || response?.errors?.[0]?.message || 'unknown response'}`)
    drafts.push({ channel: name, id: post.id, status: post.status || 'draft', videoAttachmentRequired: !!vimeo?.url })
  }
  return { status: 'draft', drafts, note: vimeo?.url ? `Attach the approved video manually: ${vimeo.url}` : undefined }
}

export function prepareBehanceManifest(job: ArchiveJob, vimeo: any | null, media: DropboxArchiveFile[], archiveFolderPath?: string): any {
  const mainMedia = media.filter((item) => !/\/Process\//i.test(item.path)).map((item) => item.path)
  const processMedia = job.settings.includeProcess
    ? media.filter((item) => /\/Process\//i.test(item.path)).map((item) => item.path)
    : []
  const contentModules = [
    { kind: 'text', role: 'title', text: [job.settings.title, job.settings.subtitle].filter(Boolean).join('\n') },
    ...(mainMedia[0] ? [{ kind: 'media', paths: [mainMedia[0]] }] : []),
    ...(job.settings.description1 ? [{ kind: 'text', role: 'description', text: job.settings.description1 }] : []),
    ...(mainMedia.length > 1 ? [{ kind: 'media', paths: mainMedia.slice(1) }] : []),
    ...(job.settings.description2 ? [{ kind: 'text', role: 'description', text: job.settings.description2 }] : []),
    ...(processMedia.length ? [
      { kind: 'text', role: 'heading', text: 'Process' },
      { kind: 'media', paths: processMedia },
    ] : []),
    ...(job.settings.description3 ? [{ kind: 'text', role: 'description', text: job.settings.description3 }] : []),
    ...(job.settings.credits ? [{ kind: 'text', role: 'credits', text: job.settings.credits }] : []),
  ]
  return {
    status: 'ready',
    title: job.settings.title,
    subtitle: job.settings.subtitle,
    descriptions: [job.settings.description1, job.settings.description2, job.settings.description3].filter(Boolean),
    excerpt: job.settings.excerpt,
    credits: job.settings.credits,
    services: job.settings.services,
    tags: [...new Set([job.project_snapshot.client, ...job.settings.services].filter(Boolean))],
    media: media.map((item) => item.path),
    contentModules,
    vimeoUrl: vimeo?.url || null,
    archiveFolderPath: archiveFolderPath || null,
    backgroundColor: job.settings.backgroundColor,
    note: 'Ready for the dedicated studio browser worker. The worker saves a draft and is technically prevented from publishing it.',
  }
}

export async function invokeArchiveMediaWorker(job: ArchiveJob, sourcePath: string, archiveFolderPath: string): Promise<any> {
  const url = process.env.KIT_ARCHIVE_MEDIA_WORKER_URL
  const secret = process.env.KIT_ARCHIVE_WORKER_SECRET
  if (!url || !secret) throw new Error('Archive FFmpeg worker is not configured.')
  const response = await fetch(`${url.replace(/\/$/, '')}/internal/archive-media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: job.id.replace(/-/g, ''),
      sourcePath,
      archiveFolderPath,
      baseName: archiveFolderName(job.project_snapshot),
    }),
    signal: AbortSignal.timeout(290_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.ok) throw new Error(`Archive media worker failed: ${body.error || response.status}`)
  return body.result
}
