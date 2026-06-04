// @ts-nocheck
/** Service keys matching the checkbox IDs in the Block Kit modal */
export type ServiceKey =
  | 'dropbox'
  | 'frameio'
  | 'canva'
  | 'figma'
  | 'slack'

export const ALL_SERVICES: ServiceKey[] = [
  'dropbox', 'frameio', 'canva', 'figma', 'slack',
]

export interface ProjectIntakeForm {
  projectNumber: string       // e.g. "2601"
  projectName: string
  clientName: string
  projectType: ProjectType
  projectManager: string     // Slack user ID
  teamMembers: string[]      // Slack user IDs
  startDate?: string
  deadline?: string
  description?: string
  selectedServices: ServiceKey[]
}

/** Builds the standard folder/project name: {number}_{client}_{project} */
export function buildProjectLabel(form: ProjectIntakeForm): string {
  return `${form.projectNumber}_${form.clientName}_${form.projectName}`
}

export type ProjectType =
  | 'Brand Video'
  | 'Motion Graphics'
  | 'Social Campaign'
  | 'Explainer'
  | 'Broadcast'
  | 'Other'

export interface ServiceResult {
  service: ServiceName
  success: boolean
  url?: string
  id?: string
  error?: string
}

export type ServiceName =
  | 'Dropbox'
  | 'FrameIo'
  | 'Canva'
  | 'FigJam'
  | 'Slack Channel'

export interface ProvisioningResults {
  dropbox?: ServiceResult
  frameio?: ServiceResult
  canva?: ServiceResult
  figma?: ServiceResult
  slack?: ServiceResult
  /** Kit project record created in Phase 2 */
  projectId?: string
}

export interface OrchestratorContext {
  form: ProjectIntakeForm
  workspaceId: string
  channelId?: string    // where to post summary
  userId?: string       // who triggered it
  dryRun?: boolean
}
