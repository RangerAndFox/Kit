/**
 * Builds the Block Kit modal for the /kit newproject intake form.
 *
 * Field set follows §3 of the R&F Operations Blueprint: every project
 * has a four-part spine identifier — Client Code, Project Number,
 * Shortname — that becomes the canonical name in every system. The
 * Client display name is stored separately for human-facing display
 * but is never used as an identifier.
 *
 * private_metadata carries channel_id so the interaction handler
 * knows where to post the summary.
 */
export function buildNewProjectModal(channelId: string) {
  return {
    type: 'modal' as const,
    callback_id: 'kit_provision_project',
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: 'plain_text' as const, text: 'New Project' },
    submit: { type: 'plain_text' as const, text: 'Create Project' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*Project ID format:* `[CLIENT]-[NUMBER]-[SHORTNAME]`\n' +
            '_e.g. `MS-2612B-D365-CustomerService` — used as the name in Slack, Dropbox, Frame.io, Harvest, and on the project canvases._',
        },
      },
      {
        type: 'input',
        block_id: 'client_code',
        label: { type: 'plain_text', text: 'Client Code' },
        hint: { type: 'plain_text', text: 'Short uppercase identifier. Example: MS, GOOG, NRG.' },
        element: {
          type: 'plain_text_input',
          action_id: 'val',
          max_length: 8,
          placeholder: { type: 'plain_text', text: 'e.g. MS' },
        },
      },
      {
        type: 'input',
        block_id: 'client_name',
        label: { type: 'plain_text', text: 'Client (display name)' },
        element: {
          type: 'plain_text_input',
          action_id: 'val',
          placeholder: { type: 'plain_text', text: 'e.g. Microsoft' },
        },
      },
      {
        type: 'input',
        block_id: 'project_number',
        label: { type: 'plain_text', text: 'Project Number' },
        hint: { type: 'plain_text', text: 'Studio job number. Letters and digits only.' },
        element: {
          type: 'plain_text_input',
          action_id: 'val',
          max_length: 12,
          placeholder: { type: 'plain_text', text: 'e.g. 2612B' },
        },
      },
      {
        type: 'input',
        block_id: 'shortname',
        label: { type: 'plain_text', text: 'Shortname' },
        hint: {
          type: 'plain_text',
          text: 'PascalCase, hyphenated. Becomes the descriptive part of the Project ID.',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'val',
          max_length: 60,
          placeholder: { type: 'plain_text', text: 'e.g. D365-CustomerService' },
        },
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
        label: { type: 'plain_text', text: 'Project Manager' },
        element: { type: 'users_select', action_id: 'val', placeholder: { type: 'plain_text', text: 'Select PM' } },
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
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              ':sparkles: *Will provision everything available* — Harvest project, Dropbox folder, Frame.io project, and a `#proj-` Slack channel with SoT and Running Notes canvases. ' +
              'Hit *Create Project* to confirm.',
          },
        ],
      },
    ],
  }
}
