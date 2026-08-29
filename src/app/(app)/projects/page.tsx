import { redirect } from 'next/navigation'
import { ProjectsTable } from './projects-table'
import { ProjectsHeader } from './projects-header'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

function projectHealth(status: string, dueDate: string | null): 'emerald' | 'amber' | 'coral' {
  if (['archived', 'completed', 'wrapped'].includes(status)) return 'emerald'
  if (dueDate && Date.parse(dueDate) < Date.now()) return 'coral'
  if (status === 'on_hold') return 'amber'
  return 'emerald'
}

export default async function ProjectsPage() {
  const access = await getControlCenterAccess()
  if (!access) redirect('/login')

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('projects')
    .select('id, name, client, project_code, status, budget_total, budget_spent, target_delivery')
    .eq('workspace_id', access.workspaceId)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`Unable to load projects: ${error.message}`)

  const projects = (data || []).map((row) => ({
    id: row.id,
    name: row.name || '(untitled project)',
    client_name: row.client || 'Internal',
    code: row.project_code || '—',
    status: row.status || 'unknown',
    budget: Number(row.budget_total || 0),
    spent: Number(row.budget_spent || 0),
    due_date: row.target_delivery || null,
    health: projectHealth(row.status || 'unknown', row.target_delivery || null),
  }))
  const existingClients = Array.from(new Set(projects.map((p) => p.client_name))).sort()
  return (
    <div className="space-y-6">
      <ProjectsHeader existingClients={existingClients} projectCount={projects.length} />
      <ProjectsTable projects={projects} />
    </div>
  )
}
