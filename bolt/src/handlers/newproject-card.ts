// @ts-nocheck
/**
 * Shared "Open new project form" card builder.
 *
 * Used by:
 *   - /kit newproject  (commands.ts)
 *   - "new project" / "new" keyword in DM  (messages.ts)
 *
 * Clicking the primary button posts a `kit_open_newproject_modal` action
 * with the channel id as its value, which the interaction handler uses
 * to open the modal with a fresh trigger_id.
 */

export interface NewProjectCardArgs {
  channelId: string
  /** Thread to nest the card into, when invoked from inside a Slack
   * Assistant thread (Agents & AI Apps). */
  threadTs?: string
}

export function buildNewProjectCard(channelId: string, threadTs?: string) {
  return {
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: 'New project — pick services and fill in the details.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ':rocket: *New project.* Pick which services to provision (Slack, ' +
            'Frame.io, Harvest, Dropbox) and fill in the project details in the next step.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Open project form' },
            action_id: 'kit_open_newproject_modal',
            value: channelId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            action_id: 'kit_cancel_newproject',
            value: channelId,
          },
        ],
      },
    ],
  }
}
