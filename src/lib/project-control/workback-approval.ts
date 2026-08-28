import type { WorkbackMilestone } from './workback'

export const WORKBACK_APPROVE_ACTION = 'kit_workback_approve'
export const WORKBACK_REGENERATE_ACTION = 'kit_workback_regenerate'
export const WORKBACK_REGENERATE_VIEW = 'kit_workback_regenerate_view'

export function buildWorkbackDraftMessage(input: {
  projectId: string
  projectName: string
  projectNumber: string
  producerSlackId: string
  rows: WorkbackMilestone[]
  spreadsheetId: string
}) {
  const schedule = input.rows.map((row, index) =>
    `${index + 1}. *${row.task}* — ${row.startDate === row.dueDate ? row.dueDate : `${row.startDate} → ${row.dueDate}`}`,
  ).join('\n')
  return {
    channel: input.producerSlackId,
    text: `Workback approval needed for ${input.projectNumber} ${input.projectName}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Approve ${input.projectNumber} workback` } },
      { type: 'section', text: { type: 'mrkdwn', text: `Kit drafted this schedule for *${input.projectName}*. It remains *Draft* and will not become the live schedule until you approve it.` } },
      { type: 'section', text: { type: 'mrkdwn', text: schedule } },
      { type: 'actions', elements: [
        { type: 'button', action_id: WORKBACK_APPROVE_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Approve schedule' }, value: input.projectId },
        { type: 'button', action_id: WORKBACK_REGENERATE_ACTION, text: { type: 'plain_text', text: 'Regenerate draft' }, value: input.projectId },
        { type: 'button', text: { type: 'plain_text', text: 'Edit milestones in Sheet' }, url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(input.spreadsheetId)}/edit`, action_id: 'kit_workback_open_sheet' },
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'After editing milestones in the Sheet, return here and approve. Kit will activate the current Sheet draft.' }] },
    ],
  }
}

export function buildWorkbackRegenerateModal(input: {
  projectId: string
  projectNumber: string
  startDate: string
  deadline: string
  template?: string
  milestoneCount: number
}) {
  const templates = ['Standard Sizzle', 'Fast-Turn', 'Project Update', 'Internal Project', 'Custom']
  const selected = templates.includes(input.template || '') ? input.template! : 'Standard Sizzle'
  return {
    type: 'modal',
    callback_id: WORKBACK_REGENERATE_VIEW,
    private_metadata: JSON.stringify({ projectId: input.projectId }),
    title: { type: 'plain_text', text: `Regenerate ${input.projectNumber}` },
    submit: { type: 'plain_text', text: 'Create new draft' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'input', block_id: 'start_date', label: { type: 'plain_text', text: 'Start Date' }, element: { type: 'datepicker', action_id: 'val', initial_date: input.startDate } },
      { type: 'input', block_id: 'deadline', label: { type: 'plain_text', text: 'Deadline' }, element: { type: 'datepicker', action_id: 'val', initial_date: input.deadline } },
      { type: 'input', block_id: 'workback_template', label: { type: 'plain_text', text: 'Workback Style' }, element: {
        type: 'static_select', action_id: 'val',
        initial_option: { text: { type: 'plain_text', text: selected === 'Custom' ? 'Custom (producer edits draft)' : selected }, value: selected },
        options: templates.map((template) => ({ text: { type: 'plain_text', text: template === 'Custom' ? 'Custom (producer edits draft)' : template }, value: template })),
      } },
      { type: 'input', block_id: 'milestone_count', label: { type: 'plain_text', text: 'Number of Milestones' }, hint: { type: 'plain_text', text: 'Custom creates generic milestone names for you to rename in the Sheet before approval.' }, element: {
        type: 'number_input', action_id: 'val', is_decimal_allowed: false, min_value: '2', max_value: '20', initial_value: String(input.milestoneCount),
      } },
    ],
  }
}
