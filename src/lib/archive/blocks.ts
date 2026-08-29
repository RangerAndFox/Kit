import { ARCHIVE_DESTINATIONS, type ArchiveDestination, type ArchiveJob, type ArchiveProjectSnapshot, type ArchiveSettings } from './types'

const clip = (value: string, max = 72) => value.length > max ? `${value.slice(0, max - 1)}…` : value
const plain = (value: string | null | undefined, fallback = '—') => String(value || '').trim() || fallback

export interface ArchiveProjectOption {
  id: string
  label: string
}

export function buildArchiveProjectCard(options: ArchiveProjectOption[], inferred?: ArchiveProjectOption | null): any {
  if (inferred) {
    return {
      text: `Prepare ${inferred.label} for the Ranger & Fox archive`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:package: *Archive & publish a project*\nPrepare *${inferred.label}* for the Ranger & Fox archive. Every external destination remains a draft or unlisted until a human publishes it.` } },
        { type: 'actions', elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Prepare archive' }, action_id: 'kit_open_archive_modal', value: inferred.id },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'kit_archive_cancel_picker', value: 'cancel' },
        ] },
      ],
    }
  }
  const selectOptions = options.slice(0, 100).map((option) => ({
    text: { type: 'plain_text', text: clip(option.label) },
    value: option.id,
  }))
  return {
    text: 'Choose a project to archive and publish',
    blocks: selectOptions.length ? [
      { type: 'section', text: { type: 'mrkdwn', text: ':package: *Archive & publish a project*\nChoose an existing Kit project. The form will be prefilled and all external outputs will remain drafts or unlisted.' } },
      { type: 'actions', elements: [{ type: 'static_select', action_id: 'kit_pick_archive_project', placeholder: { type: 'plain_text', text: 'Select a project' }, options: selectOptions }] },
    ] : [
      { type: 'section', text: { type: 'mrkdwn', text: ':grey_question: Kit could not find an eligible project to archive.' } },
    ],
  }
}

const destinationLabels: Record<ArchiveDestination, string> = {
  dropbox: 'Dropbox archive folder',
  vimeo: 'Vimeo — unlisted video',
  wordpress: 'Website — WordPress draft',
  buffer: 'Buffer — social drafts',
  behance: 'Behance — private browser-built draft',
}

export function buildArchiveModal(opts: {
  snapshot: ArchiveProjectSnapshot
  sourceVideoPath?: string
  detectedVideos?: string[]
  destinations: ArchiveDestination[]
  channelId: string
  workspaceId: string
  draft?: Partial<ArchiveSettings>
  draftNotice?: string
}): any {
  const s = opts.snapshot
  const draft = opts.draft || {}
  const initial = (value: unknown) => String(value || '').trim() ? { initial_value: String(value).trim() } : {}
  const destinationOptions = opts.destinations.map((id) => ({ text: { type: 'plain_text', text: destinationLabels[id] }, value: id }))
  const detected = (opts.detectedVideos || []).slice(0, 4).map((path) => `• ${path}`).join('\n')
  return {
    type: 'modal',
    callback_id: 'kit_archive_project_submit',
    private_metadata: JSON.stringify({ projectId: s.projectId, workspaceId: opts.workspaceId, channelId: opts.channelId }),
    title: { type: 'plain_text', text: 'Archive Project' },
    submit: { type: 'plain_text', text: 'Review Archive' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${plain(s.projectNumber)} — ${plain(s.client)} — ${plain(s.projectName)}*\nKit prefilled the writing from approved project context. Review every field. External outputs remain drafts or unlisted.` } },
      ...(opts.draftNotice ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: opts.draftNotice }] }] : []),
      ...(detected ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `*Detected delivery videos:*\n${detected}` }] }] : []),
      { type: 'input', block_id: 'source_video', label: { type: 'plain_text', text: 'Dropbox source video' }, hint: { type: 'plain_text', text: 'Use the full Dropbox path to the approved final video.' }, element: { type: 'plain_text_input', action_id: 'val', ...(opts.sourceVideoPath ? { initial_value: opts.sourceVideoPath } : {}), placeholder: { type: 'plain_text', text: '/production/2026/…/09_Outgoing/02_Delivery/final.mp4' } } },
      { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Portfolio title' }, element: { type: 'plain_text_input', action_id: 'val', initial_value: String(draft.title || `${s.client} | ${s.projectName}`).slice(0, 3000) } },
      { type: 'input', block_id: 'subtitle', optional: true, label: { type: 'plain_text', text: 'Subtitle' }, element: { type: 'plain_text_input', action_id: 'val', ...initial(draft.subtitle) } },
      { type: 'input', block_id: 'year', label: { type: 'plain_text', text: 'Year' }, element: { type: 'plain_text_input', action_id: 'val', initial_value: `20${s.projectNumber.slice(0, 2)}` } },
      { type: 'input', block_id: 'services', optional: true, label: { type: 'plain_text', text: 'Services' }, hint: { type: 'plain_text', text: 'Comma-separated, for example: Design, Animation, Editorial' }, element: { type: 'plain_text_input', action_id: 'val', ...initial(Array.isArray(draft.services) ? draft.services.join(', ') : '') } },
      { type: 'input', block_id: 'description_1', optional: true, label: { type: 'plain_text', text: 'Description 1 — hero intro' }, element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 3000, ...initial(draft.description1) } },
      { type: 'input', block_id: 'description_2', optional: true, label: { type: 'plain_text', text: 'Description 2 — project story' }, element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 3000, ...initial(draft.description2) } },
      { type: 'input', block_id: 'description_3', optional: true, label: { type: 'plain_text', text: 'Description 3 — additional story' }, element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 3000, ...initial(draft.description3) } },
      { type: 'input', block_id: 'credits', optional: true, label: { type: 'plain_text', text: 'Credits' }, hint: { type: 'plain_text', text: 'Verified project team only. Review roles and publication permission.' }, element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 3000, ...initial(draft.credits) } },
      { type: 'input', block_id: 'social_copy', optional: true, label: { type: 'plain_text', text: 'Social copy' }, element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 3000, ...initial(draft.socialCopy) } },
      { type: 'input', block_id: 'excerpt', optional: true, label: { type: 'plain_text', text: 'Website excerpt' }, element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 1000, ...initial(draft.excerpt) } },
      { type: 'input', block_id: 'background_color', optional: true, label: { type: 'plain_text', text: 'Background color' }, element: { type: 'plain_text_input', action_id: 'val', initial_value: '#000000' } },
      { type: 'input', block_id: 'process', optional: true, label: { type: 'plain_text', text: 'Process section' }, element: { type: 'checkboxes', action_id: 'val', options: [{ text: { type: 'plain_text', text: 'Include approved process imagery when available' }, value: 'include' }] } },
      { type: 'input', block_id: 'destinations', label: { type: 'plain_text', text: 'Prepare destinations' }, element: { type: 'checkboxes', action_id: 'val', options: destinationOptions, initial_options: destinationOptions } },
      { type: 'input', block_id: 'rights', label: { type: 'plain_text', text: 'Approval and rights' }, element: { type: 'checkboxes', action_id: 'val', options: [{ text: { type: 'plain_text', text: 'I confirm this media and copy are approved for portfolio preparation' }, value: 'confirmed' }] } },
    ],
  }
}

export function buildArchiveLoadingModal(projectId: string, channelId: string): any {
  return {
    type: 'modal',
    callback_id: 'kit_archive_loading',
    private_metadata: JSON.stringify({ projectId, channelId }),
    title: { type: 'plain_text', text: 'Archive Project' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: *Kit is drafting the archive package…*\nGathering approved project context, verified credits, delivery media, website copy, and social copy.' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Financial, contact, legal, credential, and private-feedback details are excluded.' }] },
    ],
  }
}

export function buildArchiveLoadingErrorModal(projectId: string, channelId: string, message: string): any {
  return {
    type: 'modal',
    callback_id: 'kit_archive_loading_error',
    private_metadata: JSON.stringify({ projectId, channelId }),
    title: { type: 'plain_text', text: 'Archive Project' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:warning: *Kit couldn't prepare the archive form.*\n${String(message || 'Unknown error').slice(0, 2500)}` } }],
  }
}

const statusEmoji: Record<string, string> = {
  awaiting_confirmation: ':large_yellow_circle:', queued: ':hourglass_flowing_sand:', validating: ':mag:',
  preparing_media: ':gear:', uploading_vimeo: ':vimeo:', creating_wordpress: ':wordpress:',
  creating_buffer: ':speech_balloon:', preparing_behance: ':art:', complete: ':white_check_mark:',
  partial: ':warning:', failed: ':x:', cancelled: ':no_entry_sign:',
}

export function buildArchiveConfirmationCard(job: ArchiveJob): any {
  const s = job.project_snapshot
  const cfg = job.settings
  return {
    text: `Review archive job for ${s.projectNumber} — ${s.projectName}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Archive ${s.projectNumber}` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Project*\n${s.client} — ${s.projectName}` },
        { type: 'mrkdwn', text: `*Title*\n${cfg.title}` },
        { type: 'mrkdwn', text: `*Source video*\n\`${job.source_video_path}\`` },
        { type: 'mrkdwn', text: `*Destinations*\n${job.destinations.map((d) => destinationLabels[d]).join('\n')}` },
      ] },
      { type: 'section', text: { type: 'mrkdwn', text: ':lock: *Draft-only safeguard:* Vimeo will be unlisted; WordPress and social posts remain drafts; the Behance worker can save a draft but cannot publish.' } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Start archive' }, action_id: 'kit_archive_confirm', value: job.id, confirm: { title: { type: 'plain_text', text: 'Start archive job?' }, text: { type: 'mrkdwn', text: 'Kit will create private/unlisted assets and drafts. Nothing will be published publicly.' }, confirm: { type: 'plain_text', text: 'Start' }, deny: { type: 'plain_text', text: 'Go back' } } },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'kit_archive_cancel', value: job.id },
      ] },
    ],
  }
}

export function buildArchiveProgressCard(job: ArchiveJob): any {
  const resultLines = Object.entries(job.results || {}).flatMap(([key, value]: [string, any]) => {
    if (!value) return []
    const url = value.url || value.editUrl || value.videoUrl || value.folderUrl
    return [
      `• *${key}:* ${url ? `<${url}|Open>` : value.status || 'prepared'}`,
      ...(value.proofUrl ? [`  ↳ <${value.proofUrl}|Draft proof screenshot>`] : []),
    ]
  })
  const retry = ['failed', 'partial'].includes(job.status) ? [{
    type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Retry failed steps' }, action_id: 'kit_archive_retry', value: job.id }],
  }] : []
  const behance = job.results?.behance
  const behanceActions = behance?.status === 'ready' ? [{
    type: 'actions', elements: [{
      type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Create Behance draft' },
      action_id: 'kit_behance_create_draft', value: job.id,
      confirm: {
        title: { type: 'plain_text', text: 'Build private draft?' },
        text: { type: 'mrkdwn', text: 'The studio worker will populate and save a Behance draft. It cannot click Publish.' },
        confirm: { type: 'plain_text', text: 'Create draft' }, deny: { type: 'plain_text', text: 'Cancel' },
      },
    }],
  }] : behance?.status === 'failed' ? [{
    type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Retry Behance draft' }, action_id: 'kit_behance_retry_draft', value: job.id }],
  }] : behance?.status === 'awaiting_review' && behance.url ? [{
    type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Review Behance draft' }, url: behance.url, action_id: 'kit_behance_open_draft' }],
  }] : []
  return {
    text: `Archive ${job.project_snapshot.projectNumber}: ${job.status}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Archive ${job.project_snapshot.projectNumber}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `${statusEmoji[job.status] || ':hourglass:'} *${job.status.replace(/_/g, ' ')}*\n${plain((job.progress as any)?.message, 'Kit is preparing the job…')}` } },
      ...(resultLines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Results*\n${resultLines.join('\n')}` } }] : []),
      ...(job.error ? [{ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${job.error}` } }] : []),
      ...retry,
      ...behanceActions,
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Kit only prepares drafts and unlisted assets. Review each destination before publishing.' }] },
    ],
  }
}

export function archiveSettingsFromSlack(values: any): { sourceVideoPath: string; settings: ArchiveSettings; destinations: ArchiveDestination[] } {
  const text = (block: string) => String(values?.[block]?.val?.value || '').trim()
  const selected = (block: string) => (values?.[block]?.val?.selected_options || []).map((o: any) => o.value)
  return {
    sourceVideoPath: text('source_video'),
    settings: {
      title: text('title'), subtitle: text('subtitle'), year: text('year'),
      services: text('services').split(',').map((x) => x.trim()).filter(Boolean),
      description1: text('description_1'), description2: text('description_2'), description3: text('description_3'),
      credits: text('credits'), socialCopy: text('social_copy'), excerpt: text('excerpt'),
      backgroundColor: text('background_color') || '#000000',
      includeProcess: selected('process').includes('include'),
      rightsConfirmed: selected('rights').includes('confirmed'),
    },
    destinations: selected('destinations').filter((value: string): value is ArchiveDestination =>
      (ARCHIVE_DESTINATIONS as readonly string[]).includes(value)),
  }
}
