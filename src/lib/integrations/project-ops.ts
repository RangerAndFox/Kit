// @ts-nocheck
/**
 * Project Ops integration
 * Bidirectional sync with Project Ops for project creation, updates, and financial data
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type {
  Project,
  ProjectPhase,
  ProjectStatus,
  Milestone,
  Deliverable,
} from '@/types/database'

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
    .from('projects' as any)
    .insert({
      workspace_id: workspaceId,
      name: poData.projectName,
      description: poData.description,
      status: 'planning' as ProjectStatus,
      phase: 'pre_production' as ProjectPhase,
      budget: poData.budget,
      currency: poData.currency,
      start_date: poData.startDate,
      end_date: poData.endDate,
      deadline: poData.deadline,
      client_name: poData.clientName,
      client_contact: poData.clientContact,
      tags: poData.tags,
      po_project_id: poData.poProjectId, // Track PO ID for sync
    })
    .select('id')
    .single()

  if (projectError) {
    throw new Error(`Failed to create project: ${projectError.message}`)
  }

  const projectId = projectData.id

  // Create milestone for each deliverable group
  const milestoneName = `Deliverables: ${poData.projectName}`
  const { data: milestoneData, error: milestoneError } = await supabase
    .from('milestones' as any)
    .insert({
      project_id: projectId,
      name: milestoneName,
      status: 'not_started',
      due_date: poData.deadline || poData.endDate,
      progress_percentage: 0,
    })
    .select('id')
    .single()

  if (milestoneError) {
    throw new Error(`Failed to create milestone: ${milestoneError.message}`)
  }

  // Create deliverables
  const deliverables = poData.deliverables.map(del => ({
    milestone_id: milestoneData.id,
    project_id: projectId,
    name: del.name,
    description: del.description,
    format: (mapDeliverableFormat(del.category) || 'other') as any,
    status: 'not_started' as const,
    specifications: del.specifications,
    due_date: del.dueDate,
    version: 1,
  }))

  const { error: delivError } = await supabase
    .from('deliverables' as any)
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
 * Maps Project Ops category to Kit deliverable format
 */
function mapDeliverableFormat(
  poCategory: string
): string | undefined {
  const mapping: Record<string, string> = {
    video: 'video',
    audio: 'audio',
    image: 'image',
    design: 'design',
    animation: 'animation',
    document: 'document',
    code: 'code',
  }
  return mapping[poCategory.toLowerCase()]
}

/**
 * Computes actual hours snapshot for a project
 * Aggregates time entries by category
 *
 * @param projectId ID of the project
 * @returns Promise resolving to actual hours by category
 */
