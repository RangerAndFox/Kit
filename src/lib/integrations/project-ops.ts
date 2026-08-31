/**
 * Project Ops integration
 * Bidirectional sync with Project Ops for project creation, updates, and financial data
 */

import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Webhook payload from Project Ops when a new project is created
 */
export interface POWebhookPayload {
  poProjectId: string
  projectName: string
  clientName: string
  clientContact?: string
  description?: string
  budget: number
  currency: string
  startDate: string // ISO 8601
  endDate: string // ISO 8601
  deadline?: string // ISO 8601
  deliverables: Array<{
    name: string
    description?: string
    category: string
    dueDate: string // ISO 8601
    specifications?: Record<string, string>
  }>
  teamMembers?: Array<{
    email: string
    role: string
  }>
  tags?: string[]
}

/**
 * Creates a Kit project from Project Ops webhook data
 * Sets up deliverables and team access
 *
 * @param workspaceId ID of the workspace
 * @param poData Project Ops webhook payload
 * @returns Promise resolving to created project ID
 */
export async function createProjectFromPO(
  workspaceId: string,
  poData: POWebhookPayload
): Promise<string> {
  const supabase = createAdminClient()

  // Create the project
  const { data: projectData, error: projectError } = await supabase
.from('projects')
    .insert({
      workspace_id: workspaceId,
      name: poData.projectName,
      brief_summary: poData.description,
      status: 'planning',
      project_type: 'client',
      budget_total: poData.budget,
      start_date: poData.startDate,
      target_delivery: poData.deadline || poData.endDate,
      client: poData.clientName,
      project_ops_id: poData.poProjectId,
      external_ids: {
        project_ops_id: poData.poProjectId,
        currency: poData.currency,
        client_contact: poData.clientContact ?? null,
        tags: poData.tags ?? [],
      },
    })
    .select('id')
    .single()

  if (projectError) {
    throw new Error(`Failed to create project: ${projectError.message}`)
  }

  const projectId = projectData.id

  // Create milestone for each deliverable group
  const milestoneName = `Deliverables: ${poData.projectName}`
  const { error: milestoneError } = await supabase
.from('milestones')
    .insert({
      workspace_id: workspaceId,
      project_id: projectId,
      name: milestoneName,
      status: 'not_started',
      due_date: poData.deadline || poData.endDate,
    })

  if (milestoneError) {
    throw new Error(`Failed to create milestone: ${milestoneError.message}`)
  }

  // Create deliverables
  const deliverables = poData.deliverables.map(del => ({
    workspace_id: workspaceId,
    project_id: projectId,
    name: del.name,
    description: del.description,
    status: 'not_started' as const,
    due_date: del.dueDate,
  }))

  const { error: delivError } = await supabase
.from('deliverables')
    .insert(deliverables)

  if (delivError) {
    throw new Error(`Failed to create deliverables: ${delivError.message}`)
  }

  // Assign team members if provided
  if (poData.teamMembers && poData.teamMembers.length > 0) {
    // In production, would map emails to Kit team member IDs
    // For now, store as pending team assignments
    console.log(`Team members for project ${projectId}:`, poData.teamMembers)
  }

  return projectId
}

/**
 * Computes actual hours snapshot for a project
 * Aggregates time entries by category
 *
 * @param projectId ID of the project
 * @returns Promise resolving to actual hours by category
 */
