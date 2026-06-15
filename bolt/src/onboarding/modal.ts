// @ts-nocheck
/**
 * Freelancer onboarding modal.
 *
 * Project picker + up to 3 artist slots (name, email).
 * Empty slots are ignored at submit time.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'

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
