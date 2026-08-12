// @ts-nocheck
/**
 * Shared "Update project" card builder.
 *
 * Used by:
 *   - /kit update            (commands.ts)
 *   - "update project" keyword in DM  (messages.ts)
 *
 * Two modes:
 *   - INFERRED: the flow was launched inside a project's Slack channel, so we
 *     already know the project — render a primary button whose value carries the
 *     project id; clicking it opens the pre-filled modal (kit_open_updateproject_modal).
 *   - PICKER: no project context (a DM, or an unmatched channel) — render a
 *     static_select of the workspace's editable projects; selecting one opens the
 *     modal directly (kit_pick_update_project provides its own trigger_id).
 */

export interface UpdateProjectOption {
  /** projects.id */
  id: string
  /** Display label, e.g. "2601 — Nike — Summer Campaign". */
  label: string
}

export function buildUpdateProjectCard(opts: {
  channelId: string
  threadTs?: string
  /** The single inferred project (channel match), when known. */
  inferred?: UpdateProjectOption | null
  /** Candidate projects for the picker when there is no single inference. */
  candidates?: UpdateProjectOption[]
}) {
  const { channelId, threadTs, inferred, candidates } = opts
  const ctx = (id: string) => JSON.stringify({ p: id, c: channelId, t: threadTs || '' })
  const clip = (s: string) => (s.length > 72 ? `${s.slice(0, 71)}…` : s)

  if (inferred) {
    return {
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `Update ${inferred.label} — edit the details and ripple the changes.`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `:pencil2: *Update project.* Edit *${inferred.label}* — you'll preview every change before it ripples across Slack, Dropbox, Harvest, Frame.io, and the Master Project List.` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Open update form' },
              action_id: 'kit_open_updateproject_modal',
              value: ctx(inferred.id),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Cancel' },
              action_id: 'kit_cancel_updateproject',
              value: ctx(inferred.id),
            },
          ],
        },
      ],
    }
  }

  const options = (candidates || []).slice(0, 100).map((c) => ({
    text: { type: 'plain_text', text: clip(c.label) },
    // ONLY the project id — Slack caps a static_select option value at 75 chars,
    // which a full {p,c,t} JSON with a UUID would exceed. The pick handler
    // recovers channel/thread from the interaction body instead.
    value: JSON.stringify({ p: c.id }),
  }))

  if (options.length === 0) {
    return {
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: 'No editable projects found.',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: ':grey_question: No active projects found to update in this workspace.' } },
      ],
    }
  }

  return {
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: 'Which project do you want to update?',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':pencil2: *Update project.* Pick the project to edit — you\'ll preview every change before it ripples.' } },
      {
        type: 'actions',
        elements: [
          {
            type: 'static_select',
            action_id: 'kit_pick_update_project',
            placeholder: { type: 'plain_text', text: 'Select a project' },
            options,
          },
        ],
      },
    ],
  }
}

/**
 * Match rules for the DM/keyword entry. Kept here so the card + trigger live
 * together, mirroring newproject-card's isNewProjectTrigger neighbour.
 */
export function isUpdateProjectTrigger(text: string): boolean {
  const t = (text || '').trim().toLowerCase()
  if (t.length > 60) return false // long/conversational messages go to the orchestrator
  // End-anchored like isNewProjectTrigger/isStoryboardTrigger: only a short, strict
  // intent fires the bare-keyword shortcut. "update project 2601s deadline to ..."
  // is left for the orchestrator to parse instead of being hijacked into the picker.
  return /^\/?(update|edit)\s+project(\s+please)?\.?$/.test(t)
}
