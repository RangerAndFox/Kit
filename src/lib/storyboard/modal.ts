// @ts-nocheck
/**
 * Block Kit modal for the storyboard provisioner.
 *
 * Carries one short stash token in private_metadata pointing to the
 * script/file that was queued before the modal opened. The view-submit
 * handler looks it up to dispatch to the Boords agent.
 */

export interface BuildStoryboardModalArgs {
  /** Stash token from stashIntake() — keeps the script/file out of private_metadata. */
  stashToken: string
  /** Suggested storyboard name to pre-fill (e.g. from filename). */
  suggestedName?: string
  /**
   * Has a script source already been captured? If false, the modal shows
   * a "paste your script" field; if true, we trust the stash and skip it.
   */
  scriptAttached: boolean
}

export function buildStoryboardModal(args: BuildStoryboardModalArgs) {
  const { stashToken, suggestedName, scriptAttached } = args

  const blocks: any[] = [
    {
      type: 'input',
      block_id: 'project_name',
      label: { type: 'plain_text', text: 'Storyboard name' },
      element: {
        type: 'plain_text_input',
        action_id: 'val',
        initial_value: suggestedName || '',
        placeholder: { type: 'plain_text', text: 'e.g. Acme Spring VO' },
      },
    },
  ]

  if (!scriptAttached) {
    blocks.push({
      type: 'input',
      block_id: 'script',
      optional: true,
      label: { type: 'plain_text', text: 'Script' },
      hint: {
        type: 'plain_text',
        text: 'Paste the script (up to 3000 chars). For longer scripts, cancel and drop a .docx or .txt in the DM. Leave empty for a blank storyboard.',
      },
      element: {
        type: 'plain_text_input',
        action_id: 'val',
        multiline: true,
        max_length: 3000,
      },
    })
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':page_facing_up: Script attached — Kit will parse it on submit.',
      },
    })
  }

  blocks.push(
    {
      type: 'input',
      block_id: 'video_style',
      optional: true,
      label: { type: 'plain_text', text: 'Video style' },
      element: {
        type: 'static_select',
        action_id: 'val',
        placeholder: { type: 'plain_text', text: 'Pick a style' },
        options: [
          { text: { type: 'plain_text', text: 'Realistic' }, value: 'Realistic' },
          { text: { type: 'plain_text', text: 'Animated' }, value: 'Animated' },
          { text: { type: 'plain_text', text: 'Mixed' }, value: 'Mixed' },
          { text: { type: 'plain_text', text: 'Other / unspecified' }, value: 'Other' },
        ],
      },
    },
    {
      type: 'input',
      block_id: 'aspect_ratio',
      label: { type: 'plain_text', text: 'Aspect ratio' },
      element: {
        type: 'static_select',
        action_id: 'val',
        initial_option: {
          text: { type: 'plain_text', text: '16:9 (landscape)' },
          value: '16:9',
        },
        options: [
          { text: { type: 'plain_text', text: '16:9 (landscape)' }, value: '16:9' },
          { text: { type: 'plain_text', text: '9:16 (vertical / social)' }, value: '9:16' },
          { text: { type: 'plain_text', text: '1:1 (square)' }, value: '1:1' },
          { text: { type: 'plain_text', text: '4:5 (portrait)' }, value: '4:5' },
          { text: { type: 'plain_text', text: '21:9 (cinematic)' }, value: '21:9' },
        ],
      },
    },
    {
      type: 'input',
      block_id: 'seconds_per_frame',
      label: { type: 'plain_text', text: 'Seconds per frame' },
      element: {
        type: 'static_select',
        action_id: 'val',
        initial_option: {
          text: { type: 'plain_text', text: '5 seconds' },
          value: '5',
        },
        options: [
          { text: { type: 'plain_text', text: '3 seconds' }, value: '3' },
          { text: { type: 'plain_text', text: '5 seconds' }, value: '5' },
          { text: { type: 'plain_text', text: '8 seconds' }, value: '8' },
          { text: { type: 'plain_text', text: '10 seconds' }, value: '10' },
        ],
      },
    },
    {
      type: 'input',
      block_id: 'mode',
      label: { type: 'plain_text', text: 'Extraction mode' },
      element: {
        type: 'static_select',
        action_id: 'val',
        initial_option: {
          text: { type: 'plain_text', text: 'Auto (recommended)' },
          value: 'auto',
        },
        options: [
          { text: { type: 'plain_text', text: 'Auto (recommended)' }, value: 'auto' },
          { text: { type: 'plain_text', text: 'Sentence split' }, value: 'sentence' },
          { text: { type: 'plain_text', text: 'A/V table only' }, value: 'table' },
          { text: { type: 'plain_text', text: 'AI scene extraction' }, value: 'ai' },
        ],
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            ':sparkles: Kit will parse the script, create the storyboard in Boords, ' +
            'and post the link back here.',
        },
      ],
    },
  )

  return {
    type: 'modal' as const,
    callback_id: 'kit_provision_storyboard',
    private_metadata: JSON.stringify({ stashToken }),
    title: { type: 'plain_text' as const, text: 'New Storyboard' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks,
  }
}
