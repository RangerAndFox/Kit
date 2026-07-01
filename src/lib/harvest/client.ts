// @ts-nocheck
/**
 * Harvest v2 API Client
 *
 * Personal access token auth. Requires env vars:
 *   HARVEST_ACCESS_TOKEN  — from Harvest Developer Tools
 *   HARVEST_ACCOUNT_ID    — your Harvest account ID
 */

const BASE_URL = 'https://api.harvestapp.com/v2'

function headers() {
  const token = process.env.HARVEST_ACCESS_TOKEN
  const accountId = process.env.HARVEST_ACCOUNT_ID
  if (!token || !accountId) {
    throw new Error('HARVEST_ACCESS_TOKEN and HARVEST_ACCOUNT_ID must be set')
  }
  return {
    Authorization: `Bearer ${token}`,
    'Harvest-Account-Id': accountId,
    'Content-Type': 'application/json',
    'User-Agent': 'Kit (kit@rangerandfox.tv)',
  }
}

async function harvestGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  const res = await fetch(url.toString(), {
    headers: headers(),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Harvest GET ${path}: ${res.status} ${body}`)
  }
  return res.json()
}

/**
 * Fetch every page of a Harvest list endpoint, concatenating `key` arrays.
 * Harvest caps per_page at 100 and reports `next_page` — a single-page fetch
 * silently truncates once the studio passes 100 clients/projects/users
 * (which had findOrCreateClient creating duplicate clients).
 */
async function harvestGetAll(
  path: string,
  key: string,
  params: Record<string, string> = {},
): Promise<any[]> {
  const out: any[] = []
  let page = 1
  const MAX_PAGES = 20 // 2,000 rows — far above studio scale; loop safety cap
  while (page <= MAX_PAGES) {
    const data = await harvestGet(path, { ...params, per_page: '100', page: String(page) })
    out.push(...(data[key] || []))
    if (!data.next_page) break
    page = data.next_page
  }
  return out
}

async function harvestPost(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Harvest POST ${path}: ${res.status} ${text}`)
  }
  return res.json()
}

// ─── Types ──────────────────────────────────────────────────

export interface HarvestProject {
  id: number
  name: string
  code: string
  is_active: boolean
  client?: { id: number; name: string }
}

export interface HarvestTask {
  id: number
  name: string
  is_active: boolean
}

export interface HarvestProjectTask {
  id: number // task_assignment id
  task: HarvestTask
  is_active: boolean
}

export interface HarvestUser {
  id: number
  first_name: string
  last_name: string
  email: string
  is_active: boolean
}

export interface HarvestTimeEntry {
  id: number
  project: { id: number; name: string }
  task: { id: number; name: string }
  user: { id: number; name: string }
  hours: number
  spent_date: string
  notes: string
}

// ─── Clients ───────────────────────────────────────────────

export interface HarvestClient {
  id: number
  name: string
  is_active: boolean
}

/**
 * List all clients.
 */
export async function listClients(): Promise<HarvestClient[]> {
  const clients = await harvestGetAll('/clients', 'clients', { is_active: 'true' })
  return clients.map((c: any) => ({
    id: c.id,
    name: c.name,
    is_active: c.is_active,
  }))
}

/**
 * Find an existing client by name (case-insensitive), or create a new one.
 */
export async function findOrCreateClient(name: string): Promise<HarvestClient> {
  const existing = await listClients()
  const match = existing.find((c) => c.name.toLowerCase() === name.toLowerCase())
  if (match) return match

  const data = await harvestPost('/clients', { name })
  return { id: data.id, name: data.name, is_active: data.is_active }
}

// ─── Projects ───────────────────────────────────────────────

/**
 * List all active projects.
 */
export async function listProjects(activeOnly = true): Promise<HarvestProject[]> {
  const params: Record<string, string> = {}
  if (activeOnly) params.is_active = 'true'
  const projects = await harvestGetAll('/projects', 'projects', params)
  return projects.map((p: any) => ({
    id: p.id,
    name: p.name,
    code: p.code || '',
    is_active: p.is_active,
    client: p.client ? { id: p.client.id, name: p.client.name } : undefined,
  }))
}

/**
 * Search projects by name (case-insensitive partial match).
 */
export async function searchProjects(query: string): Promise<HarvestProject[]> {
  const all = await listProjects(true)
  const q = query.toLowerCase()
  return all.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      p.client?.name.toLowerCase().includes(q)
  )
}

/**
 * Create a new project in Harvest, linked to a client.
 * Automatically assigns default creative tasks.
 */
export async function createHarvestProject(opts: {
  name: string
  clientId: number
  code?: string
  isBillable?: boolean
  budgetTotal?: number
  startDate?: string
  endDate?: string
  notes?: string
}): Promise<HarvestProject & { task_assignments: HarvestProjectTask[] }> {
  const body: Record<string, unknown> = {
    client_id: opts.clientId,
    name: opts.name,
    is_billable: opts.isBillable ?? true,
    bill_by: 'Tasks',
    budget_by: opts.budgetTotal ? 'project' : 'none',
    is_active: true,
  }
  if (opts.code) body.code = opts.code
  if (opts.budgetTotal) body.budget = opts.budgetTotal
  if (opts.startDate) body.starts_on = opts.startDate
  if (opts.endDate) body.ends_on = opts.endDate
  if (opts.notes) body.notes = opts.notes

  const data = await harvestPost('/projects', body)

  const project: HarvestProject = {
    id: data.id,
    name: data.name,
    code: data.code || '',
    is_active: data.is_active,
    client: data.client ? { id: data.client.id, name: data.client.name } : undefined,
  }

  // Assign default creative tasks to the project
  const taskAssignments = await assignDefaultTasks(project.id)

  return { ...project, task_assignments: taskAssignments }
}

/**
 * List all available tasks in the Harvest account (not project-specific).
 */
export async function listAccountTasks(): Promise<HarvestTask[]> {
  const data = await harvestGet('/tasks', { is_active: 'true', per_page: '100' })
  return (data.tasks || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    is_active: t.is_active,
  }))
}

/**
 * Assign a task to a project.
 */
export async function assignTaskToProject(
  projectId: number,
  taskId: number
): Promise<HarvestProjectTask> {
  const data = await harvestPost(`/projects/${projectId}/task_assignments`, {
    task_id: taskId,
  })
  return {
    id: data.id,
    task: { id: data.task.id, name: data.task.name, is_active: true },
    is_active: data.is_active,
  }
}

/**
 * Assign common creative tasks to a project.
 * Looks for tasks matching creative keywords, or assigns the first few available.
 */
async function assignDefaultTasks(projectId: number): Promise<HarvestProjectTask[]> {
  const allTasks = await listAccountTasks()
  if (allTasks.length === 0) return []

  // Preferred creative task names (in priority order)
  const preferredNames = [
    'design', 'animation', 'production', 'video production',
    'creative', 'art direction', 'editing', 'motion graphics',
    'project management', 'meetings',
  ]

  const toAssign: HarvestTask[] = []

  // First pass: grab tasks that match preferred names
  for (const name of preferredNames) {
    const match = allTasks.find(
      (t) => t.name.toLowerCase() === name && !toAssign.some((a) => a.id === t.id)
    )
    if (match) toAssign.push(match)
  }

  // If we didn't find any preferred tasks, take the first 3
  if (toAssign.length === 0) {
    toAssign.push(...allTasks.slice(0, 3))
  }

  // Cap at 5 tasks and assign in parallel
  const capped = toAssign.slice(0, 5)
  const results = await Promise.allSettled(
    capped.map((task) => assignTaskToProject(projectId, task.id))
  )

  return results
    .filter((r): r is PromiseFulfilledResult<HarvestProjectTask> => r.status === 'fulfilled')
    .map((r) => r.value)
}

// ─── Budget reporting ───────────────────────────────────────

export interface ProjectBudgetRow {
  projectId: number
  budget: number | null
  budgetSpent: number | null
  budgetRemaining: number | null
  /**
   * Harvest's budget_by. Units of budget/spent/remaining follow it: hours for
   * 'project' / 'task' / 'person', money for the '*_cost' / '*_fees' variants.
   */
  budgetBy: string | null
  isActive: boolean
}

/**
 * Harvest's Project Budget report — budget vs. spent for every active project,
 * in one place. Paginated; we walk all pages (a studio fits in one).
 */
export async function getProjectBudgetReport(): Promise<ProjectBudgetRow[]> {
  const rows: ProjectBudgetRow[] = []
  let page = 1
  for (let guard = 0; guard < 20; guard++) {
    const data = await harvestGet('/reports/project_budget', {
      page: String(page),
      per_page: '2000',
    })
    for (const r of data.results || []) {
      rows.push({
        projectId: r.project_id,
        budget: r.budget ?? null,
        budgetSpent: r.budget_spent ?? null,
        budgetRemaining: r.budget_remaining ?? null,
        budgetBy: r.budget_by ?? null,
        isActive: r.is_active,
      })
    }
    if (!data.next_page) break
    page = data.next_page
  }
  return rows
}

// ─── Tasks ──────────────────────────────────────────────────

/**
 * List tasks assigned to a project.
 */
export async function listProjectTasks(projectId: number): Promise<HarvestProjectTask[]> {
  const data = await harvestGet(`/projects/${projectId}/task_assignments`, {
    is_active: 'true',
    per_page: '100',
  })
  return (data.task_assignments || []).map((ta: any) => ({
    id: ta.id,
    task: { id: ta.task.id, name: ta.task.name, is_active: ta.is_active },
    is_active: ta.is_active,
  }))
}

/**
 * Get the default task for a project (first active task, or "Design" if available).
 */
export async function getDefaultTask(projectId: number): Promise<HarvestTask | null> {
  const tasks = await listProjectTasks(projectId)
  if (tasks.length === 0) return null

  // Prefer common creative task names
  const preferred = ['design', 'animation', 'production', 'video production', 'creative']
  for (const name of preferred) {
    const match = tasks.find((t) => t.task.name.toLowerCase() === name && t.is_active)
    if (match) return match.task
  }

  // Fall back to first active task
  const active = tasks.find((t) => t.is_active)
  return active ? active.task : tasks[0].task
}

// ─── Time Entries ───────────────────────────────────────────

/**
 * Create a time entry in Harvest.
 */
export async function createTimeEntry(opts: {
  projectId: number
  taskId: number
  hours: number
  spentDate?: string // YYYY-MM-DD, defaults to today
  notes?: string
  userId?: number // if attributing to a specific user
}): Promise<HarvestTimeEntry> {
  const body: Record<string, unknown> = {
    project_id: opts.projectId,
    task_id: opts.taskId,
    hours: opts.hours,
    spent_date: opts.spentDate || new Date().toISOString().split('T')[0],
  }
  if (opts.notes) body.notes = opts.notes
  if (opts.userId) body.user_id = opts.userId

  const data = await harvestPost('/time_entries', body)
  return {
    id: data.id,
    project: { id: data.project.id, name: data.project.name },
    task: { id: data.task.id, name: data.task.name },
    user: { id: data.user.id, name: data.user.name },
    hours: data.hours,
    spent_date: data.spent_date,
    notes: data.notes || '',
  }
}

/**
 * List time entries for a specific Harvest user between two dates (inclusive).
 * Used by the daily check-in to build a "recent projects" prior.
 */
export async function listTimeEntriesForUser(opts: {
  userId: number
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}): Promise<HarvestTimeEntry[]> {
  const data = await harvestGet('/time_entries', {
    user_id: String(opts.userId),
    from: opts.from,
    to: opts.to,
    per_page: '100',
  })
  return (data.time_entries || []).map((te: any) => ({
    id: te.id,
    project: { id: te.project.id, name: te.project.name },
    task: { id: te.task.id, name: te.task.name },
    user: { id: te.user.id, name: te.user.name },
    hours: te.hours,
    spent_date: te.spent_date,
    notes: te.notes || '',
  }))
}

// ─── Users ──────────────────────────────────────────────────

/**
 * List all active users.
 */
export async function listUsers(): Promise<HarvestUser[]> {
  const users = await harvestGetAll('/users', 'users', { is_active: 'true' })
  return users.map((u: any) => ({
    id: u.id,
    first_name: u.first_name,
    last_name: u.last_name,
    email: u.email,
    is_active: u.is_active,
  }))
}

/**
 * Find an existing Harvest user by email, or create one.
 * Used by freelancer onboarding.
 */
export async function findOrCreateUser(opts: {
  email: string
  firstName: string
  lastName: string
  isContractor?: boolean
}): Promise<HarvestUser> {
  const all = await listUsers()
  const match = all.find((u) => u.email.toLowerCase() === opts.email.toLowerCase())
  if (match) return match

  const body: Record<string, unknown> = {
    first_name: opts.firstName,
    last_name: opts.lastName,
    email: opts.email,
    is_contractor: opts.isContractor ?? true,
  }
  const data = await harvestPost('/users', body)
  return {
    id: data.id,
    first_name: data.first_name,
    last_name: data.last_name,
    email: data.email,
    is_active: data.is_active,
  }
}

/**
 * Assign a Harvest user to a project (creates a user_assignment).
 * Idempotent — returns the existing assignment if one already exists.
 */
export async function assignUserToProject(opts: {
  projectId: number
  userId: number
  hourlyRate?: number
}): Promise<{ id: number; user_id: number; project_id: number }> {
  // Check existing assignments first to make this idempotent.
  const existing = await harvestGet(`/projects/${opts.projectId}/user_assignments`, {
    is_active: 'true',
    per_page: '100',
  })
  const found = (existing.user_assignments || []).find(
    (ua: any) => ua.user?.id === opts.userId,
  )
  if (found) {
    return {
      id: found.id,
      user_id: found.user.id,
      project_id: opts.projectId,
    }
  }

  const body: Record<string, unknown> = { user_id: opts.userId }
  if (opts.hourlyRate != null) body.hourly_rate = opts.hourlyRate
  const data = await harvestPost(`/projects/${opts.projectId}/user_assignments`, body)
  return { id: data.id, user_id: data.user.id, project_id: opts.projectId }
}
