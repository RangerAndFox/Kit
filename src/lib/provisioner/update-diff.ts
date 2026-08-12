/**
 * Pure diff/plan logic for the "update project" flow.
 *
 * `computeUpdatePlan(current, next)` compares the project's current authoritative
 * values against the values submitted in the update modal and produces:
 *   - `changes`  — the human-facing field-level diff (for the preview message)
 *   - `derived`  — the recomputed identity strings that changed (project code,
 *                  Dropbox safe-name, Slack slug, Frame.io label) so the preview
 *                  can show old → new and the executor knows the rename targets
 *   - `services` — which outlets must ripple (slack/frameio/harvest/dropbox/
 *                  sheet/supabase)
 *   - `identityChanged` — whether a spine field (number/client/name) moved,
 *                  which is what forces the external renames
 *
 * All identity derivations go through `deriveProjectIdentifiers` so the rename
 * targets are byte-identical to what create produced. This module has no I/O.
 */

import { deriveProjectIdentifiers } from './identifiers'

/** The current authoritative state of a project (assembled from the Master
 *  Project List row for Kit-owned fields + the Supabase row for the rest). */
export interface ProjectSnapshot {
  projectId: string
  projectNumber: string
  clientName: string
  clientContact?: string | null
  projectName: string
  projectType?: string | null
  projectManagerSlackId?: string | null
  creativeDirectorSlackId?: string | null
  startDate?: string | null
  targetDelivery?: string | null
  briefSummary?: string | null
}

/** The extracted update-modal form (new values). Field names match the create
 *  handler's extraction so the same extraction code can be reused. */
export interface UpdateForm {
  projectNumber: string
  clientName: string
  clientContact?: string
  projectName: string
  projectType?: string
  projectManager?: string // slack user id
  creativeDirector?: string // slack user id
  startDate?: string
  deadline?: string
  description?: string
}

export interface FieldChange {
  /** Stable key, e.g. 'project_name'. */
  field: string
  /** Human label for the preview, e.g. 'Project Name'. */
  label: string
  /** True when old/new are Slack user ids (render as <@id> in the preview). */
  isUser?: boolean
  old: string | null
  new: string | null
}

export interface DerivedChange {
  old: string
  new: string
}

export interface UpdateServiceFlags {
  slack: boolean
  frameio: boolean
  harvest: boolean
  dropbox: boolean
  sheet: boolean
  supabase: boolean
}

export interface UpdatePlan {
  changes: FieldChange[]
  derived: {
    projectCode?: DerivedChange
    dropboxSafeName?: DerivedChange
    slackSlug?: DerivedChange
    frameioBusinessLabel?: DerivedChange
  }
  services: UpdateServiceFlags
  /** A spine field (number / client / name) moved — external renames required. */
  identityChanged: boolean
  hasChanges: boolean
}

/** Normalize a nullable field for comparison: trim, treat null/undefined as ''. */
function norm(v: string | null | undefined): string {
  return (v ?? '').toString().trim()
}

/** null when empty, else the trimmed value — for a FieldChange side. */
function side(v: string | null | undefined): string | null {
  const n = norm(v)
  return n === '' ? null : n
}

interface FieldSpec {
  field: string
  label: string
  isUser?: boolean
  current: string | null | undefined
  next: string | null | undefined
}

/** Which external services the project ACTUALLY has provisioned. A service the
 *  project was created without (unchecked in the new-project modal) must never be
 *  added to the rename plan — its rename handler would find no resource to
 *  reconcile, return terminal, and wedge the project in 'partial' forever. When
 *  omitted, every service is treated as present (the pure-diff default, used by
 *  unit tests). */
export interface ProvisionedServices {
  slack?: boolean
  frameio?: boolean
  harvest?: boolean
  dropbox?: boolean
}

export function computeUpdatePlan(
  current: ProjectSnapshot,
  next: UpdateForm,
  provisioned?: ProvisionedServices,
): UpdatePlan {
  // Client is identity-bearing (feeds the Slack slug / Dropbox folder / Frame.io
  // label / Harvest code). client_name is optional in the modal only so a
  // Harvest-synced NULL-client project stays submittable — NOT so an operator can
  // CLEAR the client on a provisioned project. A blank client would ripple an empty
  // client to Slack's rename, which hard-fails on empty and re-fails every recovery
  // cycle. So a blank client is coerced to the current value here (a no-op for BOTH
  // the diff AND the derived identity strings); you can change the client, never
  // clear it. Filling a blank one in is still a real change.
  const effClientName = norm(next.clientName) === '' ? (current.clientName ?? '') : next.clientName

  const specs: FieldSpec[] = [
    { field: 'project_number', label: 'Project Number', current: current.projectNumber, next: next.projectNumber },
    { field: 'client', label: 'Client', current: current.clientName, next: effClientName },
    { field: 'client_contact', label: 'Client Contact', current: current.clientContact, next: next.clientContact },
    { field: 'project_name', label: 'Project Name', current: current.projectName, next: next.projectName },
    { field: 'project_type', label: 'Project Type', current: current.projectType, next: next.projectType },
    { field: 'project_manager', label: 'Producer', isUser: true, current: current.projectManagerSlackId, next: next.projectManager },
    { field: 'creative_director', label: 'Creative Director', isUser: true, current: current.creativeDirectorSlackId, next: next.creativeDirector },
    { field: 'start_date', label: 'Start Date', current: current.startDate, next: next.startDate },
    { field: 'deadline', label: 'Deadline', current: current.targetDelivery, next: next.deadline },
    { field: 'description', label: 'Brief Description', current: current.briefSummary, next: next.description },
  ]

  const changes: FieldChange[] = []
  const changed = new Set<string>()
  for (const s of specs) {
    // Project Type is a static_select with no clear affordance: a blank selection
    // means "not set / no match" (e.g. a NULL or legacy non-canonical type that
    // couldn't be pre-selected), NOT an intent to clear it. Never diff a blank
    // project_type as a change — that would silently null out the stored value.
    if (s.field === 'project_type' && norm(s.next) === '') continue
    if (norm(s.current) !== norm(s.next)) {
      changed.add(s.field)
      changes.push({
        field: s.field,
        label: s.label,
        ...(s.isUser ? { isUser: true } : {}),
        old: side(s.current),
        new: side(s.next),
      })
    }
  }

  // Recompute the identity strings from both sides using the SAME project id
  // (the id is stable across renames and only feeds the Slack short-id suffix).
  const oldIds = deriveProjectIdentifiers({
    projectId: current.projectId,
    projectNumber: current.projectNumber,
    client: current.clientName,
    projectName: current.projectName,
  })
  const newIds = deriveProjectIdentifiers({
    projectId: current.projectId,
    projectNumber: next.projectNumber,
    client: effClientName,
    projectName: next.projectName,
  })

  const derived: UpdatePlan['derived'] = {}
  if (oldIds.projectCode !== newIds.projectCode) derived.projectCode = { old: oldIds.projectCode, new: newIds.projectCode }
  if (oldIds.dropboxSafeName !== newIds.dropboxSafeName) derived.dropboxSafeName = { old: oldIds.dropboxSafeName, new: newIds.dropboxSafeName }
  if (oldIds.slackSlug !== newIds.slackSlug) derived.slackSlug = { old: oldIds.slackSlug, new: newIds.slackSlug }
  if (oldIds.frameioBusinessLabel !== newIds.frameioBusinessLabel) derived.frameioBusinessLabel = { old: oldIds.frameioBusinessLabel, new: newIds.frameioBusinessLabel }

  const nameChanged = changed.has('project_name')
  const clientChanged = changed.has('client')

  // Gate each external service on whether the project actually has it (default
  // present when the caller doesn't know).
  const has = {
    slack: provisioned?.slack ?? true,
    frameio: provisioned?.frameio ?? true,
    harvest: provisioned?.harvest ?? true,
    dropbox: provisioned?.dropbox ?? true,
  }

  const services: UpdateServiceFlags = {
    // Dropbox folder moves only when its safe-name string moves.
    dropbox: has.dropbox && !!derived.dropboxSafeName,
    // Frame.io project name is the business label.
    frameio: has.frameio && !!derived.frameioBusinessLabel,
    // Harvest project name = project name; code = project code. OR in the raw
    // clientChanged flag (like the Slack gate below): deriveProjectCode strips
    // internal whitespace, so a whitespace-only client rename ('Coca Cola' →
    // 'CocaCola') leaves projectCode identical yet is a real client change that
    // must re-parent the Harvest project.
    harvest: has.harvest && (nameChanged || clientChanged || !!derived.projectCode),
    // Slack: rename when the slug base moves, or refresh topic/purpose text
    // (which embeds `${client} — ${projectName}`) when either moves.
    slack: has.slack && (!!derived.slackSlug || clientChanged || nameChanged),
    // Master Project List: any Kit-owned cell changed.
    sheet:
      changed.has('project_number') ||
      changed.has('client') ||
      changed.has('client_contact') ||
      changed.has('project_name') ||
      changed.has('start_date') ||
      changed.has('deadline') ||
      changed.has('creative_director') ||
      changed.has('project_manager'),
    // Supabase projects row: any tracked scalar changed.
    supabase: changes.length > 0,
  }

  const identityChanged =
    changed.has('project_number') || changed.has('client') || changed.has('project_name')

  return { changes, derived, services, identityChanged, hasChanges: changes.length > 0 }
}
