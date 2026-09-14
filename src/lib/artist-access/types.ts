export const OFFBOARD_STEPS = ['slack', 'dropbox', 'frameio', 'kit_access', 'assignments', 'harvest'] as const
export type OffboardStep = typeof OFFBOARD_STEPS[number]
export type StepResult = { status: 'removed' | 'retained' | 'review' | 'failed'; detail: string }
export type Grant = { resource?: string; subject?: string; account?: string; invite?: string; status: string }
export type Engagement = {
  id: string; workspace_id: string; project_id: string; artist_email: string; artist_name: string
  artist_slack_id: string | null; state: 'active' | 'onboarding' | 'offboarding' | 'offboarded'
  revision: number; grants: Partial<Record<OffboardStep, Grant>>; ended_at: string | null
}
export type OffboardSnapshot = {
  engagement: Engagement; projectName: string; projectNumber: string
  slackChannel?: string; dropboxPath?: string; frameioProject?: string; frameioAccount?: string
  assignmentsConfigured: boolean; lastWorkingDate: string
}
export type OffboardRequest = {
  id: string; workspace_id: string; engagement_id: string; actor: string; snapshot: OffboardSnapshot
  status: 'pending' | 'running' | 'partial' | 'complete' | 'cancelled'
  results: Partial<Record<OffboardStep, StepResult>>; expires_at: string
}
export const identityEmail = (value: string) => value.trim().toLowerCase()
export function safeLabel(value: string): string { return value.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!)) }
export function finished(result?: StepResult): boolean { return result?.status === 'removed' || result?.status === 'retained' }
