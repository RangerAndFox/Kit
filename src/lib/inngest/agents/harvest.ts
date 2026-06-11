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
  findHarvestProjectByKitId,
  assignDefaultTasks,
  assignAllUsersToProject,
  listProjects,
  searchProjects,
  listProjectTasks,
  getDefaultTask,
  createTimeEntry,
  listUsers,
  listAccountTasks,
  getProjectBudgetReport,
  type HarvestProject,
  type HarvestProjectTask,
} from '@/lib/harvest/client'
import { studioToday, studioDateMinusDays } from '@/lib/time/studio-date'
import { staffProfile } from '@/lib/staff/timezone'
import type { AgentDefinition, AgentResult } from './types'

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const kitProjectId = (payload.projectId as string) || ''
    const harvestClient = await findOrCreateClient(payload.client as string)

    // Reconcile by embedded Kit identity FIRST: if this exact Kit project already
    // created a Harvest project (e.g. a prior attempt crashed before the step
    // ledger was updated), reuse it instead of creating a duplicate. Only create
    // when absence is proven.
    const existing = kitProjectId ? await findHarvestProjectByKitId(kitProjectId) : null
    let project: HarvestProject & { task_assignments: HarvestProjectTask[] }
    if (existing) {
      // Complete follow-up setup idempotently against the reused project.
      const task_assignments = await assignDefaultTasks(existing.id)
      project = { ...existing, task_assignments }
    } else {
      project = await createHarvestProject({
        name: payload.projectName as string,
        clientId: harvestClient.id,
        code: (payload.projectCode as string) || undefined,
        isBillable: true,
        budgetTotal: (payload.budgetTotal as number) || undefined,
        startDate: (payload.startDate as string) || undefined,
        endDate: (payload.targetDelivery as string) || undefined,
        notes: (payload.briefSummary as string) || undefined,
        kitProjectId: kitProjectId || undefined,
      })
    }

    // Studio policy: everyone is assigned to every project, so time entry
    // never hits Harvest's must-be-assigned rule. Non-fatal — the
    // createTimeEntry self-heal covers any user this misses.
    let teamAssigned = 0
    try {
      teamAssigned = (await assignAllUsersToProject(project.id)).assigned
    } catch (err: any) {
      console.warn(`[harvest] team assignment for new project ${project.id} failed: ${err.message}`)
    }

    return {
      agent: 'harvest',
      action: 'provision',
      success: true,
      url: `https://rangerandfox.harvestapp.com/projects/${project.id}`,
      id: String(project.id),
      message: `Created Harvest project "${project.name}" with ${project.task_assignments.length} tasks; assigned ${teamAssigned} team members`,
      data: {
        clientName: harvestClient.name,
        clientId: harvestClient.id,
        taskCount: project.task_assignments.length,
        tasks: project.task_assignments.map((ta: any) => ta.task.name),
        teamAssigned,
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
    // Anchor everything to the LOGGER's timezone (staff.timezone, cached
    // from their Slack profile; studio default when unknown) — a UTC
    // "today" is already tomorrow by 5pm PT, which put evening entries on
    // the next day. The specialist LLM isn't told the current date, so
    // relative words are resolved here and non-dates / future dates fall
    // back to today.
    const { timezone: tz, harvestUserId } = await staffProfile(payload.slackUserId as string)
    const rawDate = String(payload.date || '').trim().toLowerCase()
    const today = studioToday(new Date(), tz)
    let date: string
    if (rawDate === 'yesterday') date = studioDateMinusDays(1, new Date(), tz)
    else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawDate <= today) date = rawDate
    else date = today

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

    // Attribute to the LOGGER — without user_id Harvest books the entry
    // to the API token owner, i.e. someone else's timesheet.
    const entry = await createTimeEntry({
      projectId: project.id,
      taskId,
      hours,
      spentDate: date,
      notes,
      userId: harvestUserId || undefined,
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

    // Pull real budget vs. spent from Harvest's project budget report and join
    // it onto the matches. Non-fatal: if the report fails we still return the
    // matches (without budget numbers) rather than erroring.
    let byId = new Map<number, any>()
    try {
      const report = await getProjectBudgetReport()
      byId = new Map(report.map((r) => [r.projectId, r]))
    } catch (e: any) {
      console.warn('[harvest] project budget report failed:', e.message)
    }

    const results = projects.map((p) => {
      const b = byId.get(p.id)
      return {
        id: p.id,
        name: p.name,
        code: p.code,
        client: p.client?.name,
        isActive: p.is_active,
        budget: b?.budget ?? null,
        spent: b?.budgetSpent ?? null,
        remaining: b?.budgetRemaining ?? null,
        budgetBy: b?.budgetBy ?? null,
      }
    })

    // Human-readable headline for the best match. Units follow budget_by:
    // money for the *_cost/*_fees variants, otherwise hours.
    const top = results[0]
    const isMoney = !!top.budgetBy && /(cost|fees)/i.test(top.budgetBy)
    const unit = isMoney ? 'USD' : 'hours'
    const message =
      top.budget != null
        ? `${top.name}: ${top.spent ?? 0}/${top.budget} ${unit} spent` +
          (top.remaining != null ? ` (${top.remaining} ${unit} remaining)` : '')
        : `${top.name}: no budget set in Harvest`

    return {
      agent: 'harvest',
      action: 'get_budget',
      success: true,
      message,
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
      inputDescription:
        'project (name/code), hours, task (optional), notes (optional), date (optional: YYYY-MM-DD or the word "yesterday" — omit for today; resolved in the studio timezone)',
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
