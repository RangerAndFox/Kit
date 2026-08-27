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
  boords: 'Boords — blank storyboard project',
}

const PROJECT_TYPE_OPTIONS = [
  'Brand Video',
  'Motion Graphics',
  'Social Campaign',
  'Explainer',
  'Broadcast',
  'Other',
]

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
        block_id: 'client_contact',
        optional: true,
        label: { type: 'plain_text', text: 'Client Contact' },
        hint: { type: 'plain_text', text: 'The client-side point of contact (name and/or email). Written verbatim to the Master Project List.' },
        element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. Jane Doe — jane@nike.com' } },
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
        label: { type: 'plain_text', text: 'Budget (hours)' },
        hint: { type: 'plain_text', text: 'Total project hours. Harvest budgets by hours and can\'t be changed after the project is created — enter it now if known.' },
        element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. 120' } },
      },
      {
        type: 'input',
        block_id: 'project_type',
        label: { type: 'plain_text', text: 'Project Type' },
        element: {
          type: 'static_select',
          action_id: 'val',
          placeholder: { type: 'plain_text', text: 'Select type' },
          options: PROJECT_TYPE_OPTIONS.map((t) => ({ text: { type: 'plain_text', text: t }, value: t })),
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
        block_id: 'workback_template',
        label: { type: 'plain_text', text: 'Workback Style' },
        element: {
          type: 'static_select', action_id: 'val',
          initial_option: { text: { type: 'plain_text', text: 'Standard Sizzle' }, value: 'Standard Sizzle' },
          options: ['Standard Sizzle', 'Fast-Turn', 'Project Update', 'Internal Project', 'Custom'].map((t) => ({ text: { type: 'plain_text', text: t }, value: t })),
        },
      },
      {
        type: 'input',
        block_id: 'milestone_count',
        label: { type: 'plain_text', text: 'Number of Milestones' },
        hint: { type: 'plain_text', text: 'Kit spreads these between the start and delivery dates. You can revise the draft afterward.' },
        element: { type: 'number_input', action_id: 'val', is_decimal_allowed: false, min_value: '2', max_value: '20', initial_value: '9' },
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

/** The current values used to pre-fill the update modal (Kit-owned fields come
 *  from the authoritative Master Project List row; the rest from the projects
 *  row). Every field is optional so a partially-populated project still opens. */
export interface UpdateProjectSnapshot {
  projectNumber?: string
  clientName?: string
  clientContact?: string
  projectName?: string
  projectType?: string
  projectManagerSlackId?: string
  creativeDirectorSlackId?: string
  startDate?: string
  targetDelivery?: string
  briefSummary?: string
  /** Shown read-only — Harvest budgets are fixed at creation. */
  budgetTotal?: number | null
}

const plain = (v: string | undefined | null) => (v && String(v).trim() ? String(v) : undefined)
const isoDate = (v: string | undefined | null) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined

/**
 * Builds the PRE-FILLED "Update Project" modal — the same field block_ids as the
 * create modal (so the submit-extraction code is shared) with each field's
 * initial value populated from the current project. `budget`, `services`, and
 * `team_members` are intentionally omitted (budget is immutable, services are
 * already provisioned, team membership isn't tracked on the row).
 *
 * private_metadata carries the project id + workspace so the submit handler and
 * the confirm button can rehydrate without a picker round-trip.
 */
export function buildUpdateProjectModal(opts: {
  projectId: string
  workspaceId: string
  channelId: string
  threadTs?: string
  snapshot: UpdateProjectSnapshot
}) {
  const s = opts.snapshot
  const typeInitial = s.projectType && PROJECT_TYPE_OPTIONS.includes(s.projectType) ? s.projectType : undefined
  const opt = (text: string) => ({ text: { type: 'plain_text' as const, text }, value: text })

  const textInput = (
    block_id: string,
    label: string,
    value: string | undefined,
    extra: Record<string, unknown> = {},
    optional = false,
  ) => ({
    type: 'input',
    block_id,
    ...(optional ? { optional: true } : {}),
    label: { type: 'plain_text', text: label },
    element: {
      type: 'plain_text_input',
      action_id: 'val',
      ...(plain(value) ? { initial_value: plain(value) } : {}),
      ...extra,
    },
  })

  const userSelect = (block_id: string, label: string, user: string | undefined, optional = false) => ({
    type: 'input',
    block_id,
    ...(optional ? { optional: true } : {}),
    label: { type: 'plain_text', text: label },
    element: {
      type: 'users_select',
      action_id: 'val',
      ...(plain(user) ? { initial_user: plain(user) } : {}),
      placeholder: { type: 'plain_text', text: 'Select' },
    },
  })

  const dateInput = (block_id: string, label: string, value: string | undefined) => ({
    type: 'input',
    block_id,
    optional: true,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'datepicker',
      action_id: 'val',
      ...(isoDate(value) ? { initial_date: isoDate(value) } : {}),
    },
  })

  return {
    type: 'modal' as const,
    callback_id: 'kit_update_project',
    // Embed the OPEN-TIME snapshot so the submit handler diffs against what the
    // user was actually shown — not a fresh DB read, which would flag (and then
    // revert) any field a concurrent edit changed while this modal sat open.
    private_metadata: JSON.stringify({
      project_id: opts.projectId,
      workspace_id: opts.workspaceId,
      channel_id: opts.channelId,
      thread_ts: opts.threadTs || '',
      snap: {
        projectNumber: s.projectNumber,
        clientName: s.clientName,
        clientContact: s.clientContact,
        projectName: s.projectName,
        projectType: s.projectType,
        projectManagerSlackId: s.projectManagerSlackId,
        creativeDirectorSlackId: s.creativeDirectorSlackId,
        startDate: s.startDate,
        targetDelivery: s.targetDelivery,
        briefSummary: s.briefSummary,
      },
    }),
    title: { type: 'plain_text' as const, text: 'Update Project' },
    submit: { type: 'plain_text' as const, text: 'Review changes' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':pencil2: Edit any field. The next step previews exactly what will change across Slack, Dropbox, Harvest, Frame.io, and the Master Project List before anything is applied.' }],
      },
      // Optional, like Client: a synced/pre-existing project can have an empty
      // project number (its Harvest code may be null or carry no extractable
      // number), and a required field with no value would block ANY edit. A blank
      // is coerced to the current value in computeUpdatePlan (never a clear).
      textInput('project_number', 'Project ID', s.projectNumber, {}, true),
      // Optional: a Harvest-synced project can have a NULL client (project-sync
      // inserts `client: hp.client?.name ?? null`), and a required field with no
      // value would block any unrelated edit. An unchanged blank stays a no-op;
      // filling it in rings through as a real client change.
      textInput('client_name', 'Client', s.clientName, {}, true),
      textInput('client_contact', 'Client Contact', s.clientContact, {}, true),
      textInput('project_name', 'Project Name', s.projectName),
      {
        type: 'input',
        block_id: 'project_type',
        // Optional like every other non-identity field: a Harvest-synced project
        // (project_type NULL) or a legacy non-canonical type has no initial_option,
        // and a required select with nothing pre-selected would block Slack from
        // accepting ANY edit (e.g. a deadline fix) until a type is forced.
        optional: true,
        label: { type: 'plain_text', text: 'Project Type' },
        element: {
          type: 'static_select',
          action_id: 'val',
          placeholder: { type: 'plain_text', text: 'Select type' },
          ...(typeInitial ? { initial_option: opt(typeInitial) } : {}),
          options: PROJECT_TYPE_OPTIONS.map(opt),
        },
      },
      userSelect('project_manager', 'Producer', s.projectManagerSlackId, true),
      userSelect('creative_director', 'Creative Director', s.creativeDirectorSlackId, true),
      dateInput('start_date', 'Start Date', s.startDate),
      dateInput('deadline', 'Deadline', s.targetDelivery),
      textInput('description', 'Brief Description', s.briefSummary, { multiline: true, max_length: 1000 }, true),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              typeof s.budgetTotal === 'number'
                ? `:lock: *Budget:* ${s.budgetTotal} hours — Harvest budgets are fixed at creation and can't be changed here.`
                : ':lock: Harvest budget is fixed at creation and can\'t be changed here.',
          },
        ],
      },
    ],
  }
}
