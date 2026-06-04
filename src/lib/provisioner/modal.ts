/**
 * Builds the Block Kit modal for the /kit newproject intake form.
 * private_metadata carries channel_id so the interaction handler
 * knows where to post the summary.
 *
 * `availableServices` is the list of agent IDs (e.g. ['slack', 'frameio',
 * 'harvest', 'dropbox']) that are online — only those become checkboxes,
 * and all are pre-checked by default.
 */
const SERVICE_LABELS: Record<string, string> = {
  slack: 'Slack — channel + canvases',
  frameio: 'Frame.io — project + folders',
  harvest: 'Harvest — project + budget',
  dropbox: 'Dropbox — project folder',
}

export function buildNewProjectModal(
  channelId: string,
  availableServices: string[] = ['slack', 'frameio', 'harvest', 'dropbox'],
  threadTs?: string,
) {
  const serviceOptions = availableServices.map((id) => ({
    text: {
      type: 'plain_text' as const,
      text: SERVICE_LABELS[id] || id,
    },
    value: id,
  }))

  return {
    type: 'modal' as const,
    callback_id: 'kit_provision_project',
    private_metadata: JSON.stringify({ channel_id: channelId, thread_ts: threadTs || '' }),
    title: { type: 'plain_text' as const, text: 'New Project' },
    submit: { type: 'plain_text' as const, text: 'Create Project' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'project_number',
        label: { type: 'plain_text', text: 'Project ID' },
        element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. 2601' } },
      },
      {
        type: 'input',
        block_id: 'client_name',
        label: { type: 'plain_text', text: 'Client' },
        element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. Nike' } },
      },
      {
        type: 'input',
        block_id: 'project_name',
        label: { type: 'plain_text', text: 'Project Name' },
        element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. Summer Campaign' } },
      },
      {
        type: 'input',
        block_id: 'budget',
        optional: true,
        label: { type: 'plain_text', text: 'Budget (USD)' },
        hint: { type: 'plain_text', text: 'Harvest budget cannot be set after the project is created — enter it now if known.' },
        element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. 25000' } },
      },
      {
        type: 'input',
        block_id: 'project_type',
        label: { type: 'plain_text', text: 'Project Type' },
        element: {
          type: 'static_select',
          action_id: 'val',
          placeholder: { type: 'plain_text', text: 'Select type' },
          options: [
            { text: { type: 'plain_text', text: 'Brand Video' }, value: 'Brand Video' },
            { text: { type: 'plain_text', text: 'Motion Graphics' }, value: 'Motion Graphics' },
            { text: { type: 'plain_text', text: 'Social Campaign' }, value: 'Social Campaign' },
            { text: { type: 'plain_text', text: 'Explainer' }, value: 'Explainer' },
            { text: { type: 'plain_text', text: 'Broadcast' }, value: 'Broadcast' },
            { text: { type: 'plain_text', text: 'Other' }, value: 'Other' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'project_manager',
        label: { type: 'plain_text', text: 'Producer' },
        element: { type: 'users_select', action_id: 'val', placeholder: { type: 'plain_text', text: 'Select producer' } },
      },
      {
        type: 'input',
        block_id: 'creative_director',
        optional: true,
        label: { type: 'plain_text', text: 'Creative Director' },
        element: { type: 'users_select', action_id: 'val', placeholder: { type: 'plain_text', text: 'Select CD' } },
      },
      {
        type: 'input',
        block_id: 'team_members',
        label: { type: 'plain_text', text: 'Team Members' },
        optional: true,
        element: { type: 'multi_users_select', action_id: 'val', placeholder: { type: 'plain_text', text: 'Select team' } },
      },
      {
        type: 'input',
        block_id: 'start_date',
        optional: true,
        label: { type: 'plain_text', text: 'Start Date' },
        element: { type: 'datepicker', action_id: 'val' },
      },
      {
        type: 'input',
        block_id: 'deadline',
        optional: true,
        label: { type: 'plain_text', text: 'Deadline' },
        element: { type: 'datepicker', action_id: 'val' },
      },
      {
        type: 'input',
        block_id: 'description',
        optional: true,
        label: { type: 'plain_text', text: 'Brief Description' },
        element: { type: 'plain_text_input', action_id: 'val', multiline: true, max_length: 1000 },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'services',
        label: { type: 'plain_text', text: 'Services to provision' },
        element: {
          type: 'checkboxes',
          action_id: 'val',
          initial_options: serviceOptions,
          options: serviceOptions,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':sparkles: Uncheck anything you don\'t need. Hit *Create Project* to provision.',
          },
        ],
      },
    ],
  }
}
