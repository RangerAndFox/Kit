/**
 * Freelancer onboarding modal.
 *
 * Project picker + up to 3 artist slots (name, email).
 * Empty slots are ignored at submit time.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'
import type { ProjectMatch } from './keyword'

const MODAL_CALLBACK_ID = 'kit_onboard_submit'
const PROJECT_BLOCK_ID = 'project'
const ARTIST_NAME_BLOCK = (i: number) => `artist_${i}_name`
const ARTIST_EMAIL_BLOCK = (i: number) => `artist_${i}_email`
const ARTIST_LEGAL_BLOCK = (i: number) => `artist_${i}_legal`

/**
 * Load up to 50 recent projects for the static_select.
 */
async function loadRecentProjects(defaultProjectId?: string) {
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('id, name, client, project_code')
    .order('created_at', { ascending: false })
    .limit(50)
  return (data || []).map((p: any) => ({
    value: p.id,
    text: {
      type: 'plain_text',
      text: [p.project_code, p.client, p.name].filter(Boolean).join(' · ').slice(0, 75),
    },
  }))
}

export async function buildOnboardModal(opts: {
  channelId: string
  defaultProjectId?: string
}) {
  const options = await loadRecentProjects(opts.defaultProjectId)
  const initial = options.find((o: any) => o.value === opts.defaultProjectId)

  const artistBlocks = [0, 1, 2].flatMap((i) => [
    {
      type: 'input',
      block_id: ARTIST_NAME_BLOCK(i),
      optional: i > 0,
      label: { type: 'plain_text', text: `Artist ${i + 1} — Full name` },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: i === 0 ? 'Required' : 'Optional' },
      },
    },
    {
      type: 'input',
      block_id: ARTIST_EMAIL_BLOCK(i),
      optional: i > 0,
      label: { type: 'plain_text', text: `Artist ${i + 1} — Email` },
      element: {
        type: 'email_text_input',
        action_id: 'value',
      },
    },
    {
      type: 'input',
      block_id: ARTIST_LEGAL_BLOCK(i),
      optional: true,
      label: { type: 'plain_text', text: `Artist ${i + 1} — Legal/entity name (for NDA)` },
      hint: {
        type: 'plain_text',
        text: 'Optional — e.g. an LLC they invoice through. Defaults to their full name.',
      },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Optional' },
      },
    },
  ])

  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId: opts.channelId }),
    title: { type: 'plain_text', text: 'Onboard Freelancer' },
    submit: { type: 'plain_text', text: 'Onboard' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "Adds the artist to Slack, Dropbox, Frame.io, and Harvest for the chosen project, then DMs them a welcome message with the project brief and folder structure.",
        },
      },
      {
        type: 'input',
        block_id: PROJECT_BLOCK_ID,
        label: { type: 'plain_text', text: 'Project' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Pick a project' },
          options,
          ...(initial ? { initial_option: initial } : {}),
        },
      },
      { type: 'divider' },
      ...artistBlocks,
    ],
  }
}

export interface ParsedOnboardSubmission {
  channelId: string
  projectId: string
  artists: { name: string; email: string; legalName?: string }[]
}

const EDIT_CALLBACK_ID = 'kit_onboard_edit_submit'

/** Focused correction form for the natural-language confirmation card. */
export function buildOnboardEditModal(opts: {
  project: ProjectMatch
  artistName: string
  artistEmail: string
  artistLegalName?: string | null
  channelId: string
  messageTs: string
}) {
  return {
    type: 'modal',
    callback_id: EDIT_CALLBACK_ID,
    private_metadata: JSON.stringify({
      projectId: opts.project.id,
      channelId: opts.channelId,
      messageTs: opts.messageTs,
    }),
    title: { type: 'plain_text', text: 'Edit Freelancer' },
    submit: { type: 'plain_text', text: 'Save changes' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Project:* ${[opts.project.project_code, opts.project.client, opts.project.name].filter(Boolean).join(' · ')}`,
        },
      },
      {
        type: 'input',
        block_id: 'artist_name',
        label: { type: 'plain_text', text: 'Artist name' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: opts.artistName,
        },
      },
      {
        type: 'input',
        block_id: 'artist_email',
        label: { type: 'plain_text', text: 'Email' },
        element: {
          type: 'email_text_input',
          action_id: 'value',
          initial_value: opts.artistEmail,
        },
      },
      {
        type: 'input',
        block_id: 'artist_legal_name',
        optional: true,
        label: { type: 'plain_text', text: 'Legal/entity name (for NDA)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          ...(opts.artistLegalName ? { initial_value: opts.artistLegalName } : {}),
        },
      },
    ],
  }
}

export function parseOnboardEditSubmission(viewInput: unknown): {
  projectId: string
  channelId: string
  messageTs: string
  artistName: string
  artistEmail: string
  artistLegalName?: string
} | null {
  try {
    const view = viewInput as {
      private_metadata?: string
      state?: { values?: Record<string, { value?: { value?: string } }> }
    }
    const meta = JSON.parse(view.private_metadata || '{}')
    const values = view.state?.values || {}
    const artistName = values.artist_name?.value?.value?.trim()
    const artistEmail = values.artist_email?.value?.value?.trim()
    const artistLegalName = values.artist_legal_name?.value?.value?.trim() || undefined
    if (!meta.projectId || !meta.channelId || !meta.messageTs || !artistName || !artistEmail) return null
    return {
      projectId: meta.projectId,
      channelId: meta.channelId,
      messageTs: meta.messageTs,
      artistName,
      artistEmail,
      artistLegalName,
    }
  } catch {
    return null
  }
}

export function parseOnboardSubmission(view: any): ParsedOnboardSubmission | null {
  try {
    const meta = JSON.parse(view.private_metadata || '{}')
    const values = view.state.values
    const projectId = values[PROJECT_BLOCK_ID]?.value?.selected_option?.value
    if (!projectId) return null

    const artists: { name: string; email: string; legalName?: string }[] = []
    for (let i = 0; i < 3; i++) {
      const name = values[ARTIST_NAME_BLOCK(i)]?.value?.value?.trim()
      const email = values[ARTIST_EMAIL_BLOCK(i)]?.value?.value?.trim()
      const legalName = values[ARTIST_LEGAL_BLOCK(i)]?.value?.value?.trim() || undefined
      if (name && email) artists.push({ name, email, legalName })
    }
    if (artists.length === 0) return null

    return {
      channelId: meta.channelId || '',
      projectId,
      artists,
    }
  } catch {
    return null
  }
}
