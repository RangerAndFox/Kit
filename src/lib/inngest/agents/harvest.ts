/**
 * Harvest Agent — Time, Money & Projects Expert
 *
 * Knows everything about Harvest: time tracking, project budgets,
 * team utilization, client management, and financial reporting.
 * Kit routes any time/money question here.
 */

import {
  findOrCreateClient,
  createHarvestProject,
  listProjects,
  searchProjects,
  listProjectTasks,
  getDefaultTask,
  createTimeEntry,
  listUsers,
  listAccountTasks,
} from '@/lib/harvest/client'
import type { AgentDefinition, AgentResult } from './types'

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const harvestClient = await findOrCreateClient(payload.client as string)
    const project = await createHarvestProject({
      name: payload.projectName as string,
      clientId: harvestClient.id,
      code: (payload.projectCode as string) || undefined,
      isBillable: true,
      budgetTotal: (payload.budgetTotal as number) || undefined,
      startDate: (payload.startDate as string) || undefined,
      endDate: (payload.targetDelivery as string) || undefined,
      notes: (payload.briefSummary as string) || undefined,
    })

    return {
      agent: 'harvest',
      action: 'provision',
      success: true,
      url: `https://rangerandfox.harvestapp.com/projects/${project.id}`,
      id: String(project.id),
      message: `Created Harvest project "${project.name}" with ${project.task_assignments.length} tasks`,
      data: {
        clientName: harvestClient.name,
        clientId: harvestClient.id,
        taskCount: project.task_assignments.length,
        tasks: project.task_assignments.map((ta: any) => ta.task.name),
      },
    }
  } catch (err: any) {
    return { agent: 'harvest', action: 'provision', success: false, error: err.message }
  }
}

async function logTime(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectQuery = payload.project as string
    const hours = payload.hours as number
    const notes = (payload.notes as string) || ''
    const taskName = (payload.task as string) || ''
    const date = (payload.date as string) || new Date().toISOString().split('T')[0]

    // Find the project
    const projects = await searchProjects(projectQuery)
    if (projects.length === 0) {
      return {
        agent: 'harvest',
        action: 'log_time',
        success: false,
        error: `No project found matching "${projectQuery}"`,
      }
    }
    const project = projects[0]

    // Find the right task
    let taskId: number
    if (taskName) {
      const tasks = await listProjectTasks(project.id)
      const match = tasks.find(
        (t) => t.task.name.toLowerCase().includes(taskName.toLowerCase())
      )
      taskId = match ? match.task.id : (await getDefaultTask(project.id))!.id
    } else {
      const defaultTask = await getDefaultTask(project.id)
      if (!defaultTask) {
        return {
          agent: 'harvest',
          action: 'log_time',
          success: false,
          error: `No tasks assigned to project "${project.name}"`,
        }
      }
      taskId = defaultTask.id
    }

    const entry = await createTimeEntry({
      projectId: project.id,
      taskId,
      hours,
      spentDate: date,
      notes,
    })

    return {
      agent: 'harvest',
      action: 'log_time',
      success: true,
      message: `Logged ${hours}h on "${project.name}" → ${entry.task.name}`,
      data: {
        entryId: entry.id,
        project: entry.project.name,
        task: entry.task.name,
        hours: entry.hours,
        date: entry.spent_date,
        notes: entry.notes,
      },
    }
  } catch (err: any) {
    return { agent: 'harvest', action: 'log_time', success: false, error: err.message }
  }
}

async function getProjectBudget(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectQuery = payload.project as string
    const projects = await searchProjects(projectQuery)
    if (projects.length === 0) {
      return {
        agent: 'harvest',
        action: 'get_budget',
        success: false,
        error: `No project found matching "${projectQuery}"`,
      }
    }

    // Return all matching projects with their status
    const results = projects.map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      client: p.client?.name,
      isActive: p.is_active,
    }))

    return {
      agent: 'harvest',
      action: 'get_budget',
      success: true,
      message: `Found ${results.length} project(s) matching "${projectQuery}"`,
      data: { projects: results },
    }
  } catch (err: any) {
    return { agent: 'harvest', action: 'get_budget', success: false, error: err.message }
  }
}

async function findProjects(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const query = (payload.query as string) || ''
    const projects = query ? await searchProjects(query) : await listProjects(true)

    return {
      agent: 'harvest',
      action: 'find_projects',
      success: true,
      message: `Found ${projects.length} project(s)`,
      data: {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          client: p.client?.name,
          isActive: p.is_active,
        })),
      },
    }
  } catch (err: any) {
    return { agent: 'harvest', action: 'find_projects', success: false, error: err.message }
  }
}

async function getTeam(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const users = await listUsers()
    return {
      agent: 'harvest',
      action: 'get_team',
      success: true,
      message: `${users.length} active team members`,
      data: {
        users: users.map((u) => ({
          id: u.id,
          name: `${u.first_name} ${u.last_name}`,
          email: u.email,
        })),
      },
    }
  } catch (err: any) {
    return { agent: 'harvest', action: 'get_team', success: false, error: err.message }
  }
}

async function getProjectTasks(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectQuery = payload.project as string
    const projects = await searchProjects(projectQuery)
    if (projects.length === 0) {
      return {
        agent: 'harvest',
        action: 'get_project_tasks',
        success: false,
        error: `No project found matching "${projectQuery}"`,
      }
    }

    const tasks = await listProjectTasks(projects[0].id)
    return {
      agent: 'harvest',
      action: 'get_project_tasks',
      success: true,
      message: `${tasks.length} tasks on "${projects[0].name}"`,
      data: {
        project: projects[0].name,
        tasks: tasks.map((t) => ({
          id: t.task.id,
          name: t.task.name,
          isActive: t.is_active,
        })),
      },
    }
  } catch (err: any) {
    return { agent: 'harvest', action: 'get_project_tasks', success: false, error: err.message }
  }
}

// ─── Agent Definition ──────────────────────────────────────

export const harvestAgent: AgentDefinition = {
  id: 'harvest',
  name: 'Harvest Agent',
  domain: 'Harvest (harvestapp.com)',
  expertise:
    'Time tracking, project budgets, financial reporting, team utilization, client management, and billable hours. Ask me about hours logged, project costs, who worked on what, budget burn rates, or anything involving time and money on projects.',
  requiredEnvVars: ['HARVEST_ACCESS_TOKEN', 'HARVEST_ACCOUNT_ID'],
  capabilities: [
    {
      action: 'provision',
      description: 'Create a new Harvest project with client and default creative tasks',
      inputDescription:
        'projectName (required), client (required, will be created if new), projectCode (recommended, e.g. "2654-Microsoft"), budgetTotal (optional number), startDate (optional YYYY-MM-DD), targetDelivery (optional YYYY-MM-DD), briefSummary (optional)',
      mutates: true,
    },
    {
      action: 'log_time',
      description: 'Log a time entry for a team member on a project. Supports natural project names ("NRG", "Nike campaign") and auto-resolves the right task.',
      inputDescription: 'project (name/code), hours, task (optional), notes (optional), date (optional, defaults to today)',
      mutates: true,
    },
    {
      action: 'get_budget',
      description: 'Get budget and hours status for a project — how much has been spent vs. budgeted',
      inputDescription: 'project (name/code to search)',
      mutates: false,
    },
    {
      action: 'find_projects',
      description: 'Search for projects by name, code, or client. Returns all matches with their status.',
      inputDescription: 'query (optional, returns all active if empty)',
      mutates: false,
    },
    {
      action: 'get_team',
      description: 'List all active team members in Harvest with their IDs and emails',
      mutates: false,
    },
    {
      action: 'get_project_tasks',
      description: 'List all tasks assigned to a specific project',
      inputDescription: 'project (name/code to search)',
      mutates: false,
    },
  ],
  handler: async (action, payload) => {
    switch (action) {
      case 'provision':
        return provision(payload)
      case 'log_time':
        return logTime(payload)
      case 'get_budget':
        return getProjectBudget(payload)
      case 'find_projects':
        return findProjects(payload)
      case 'get_team':
        return getTeam(payload)
      case 'get_project_tasks':
        return getProjectTasks(payload)
      default:
        return {
          agent: 'harvest',
          action,
          success: false,
          error: `Unknown action: ${action}`,
        }
    }
  },
}
