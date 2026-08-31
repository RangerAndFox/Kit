import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import { listProjects as listHarvestProjects, searchProjects } from '../../harvest/client'
import type { KitTool } from '../types'

// ─── kit_sync_harvest_projects ──────────────────────────────

export const syncHarvestProjects: KitTool = {
  name: 'kit_sync_harvest_projects',
  description:
    'Sync Harvest projects to Kit projects by matching names. For each Kit project that does not yet have a harvest_project_id, this tool searches Harvest for a matching project and links them. Returns a summary of what was linked.',
  schema: z.object({
    workspace_id: z.string().uuid().describe('The workspace to sync'),
  }),
  handler: async ({ workspace_id }) => {
    const db = createAdminClient()

    // Get Kit projects without Harvest links
    const { data: kitProjects, error } = await db
.from('projects')
      .select('id, name, client, project_code, harvest_project_id')
      .eq('workspace_id', workspace_id)
      .in('status', ['active', 'paused'])

    if (error) return fail(error.message)
    if (!kitProjects || kitProjects.length === 0) {
      return ok({ linked: 0, message: 'No active projects found' })
    }

    // Get all Harvest projects
    const harvestProjects = await listHarvestProjects(true)
    const linked: Array<{ kitProject: string; harvestProject: string; harvestId: number }> = []
    const unmatched: string[] = []

    for (const kit of kitProjects) {
      // Skip already linked
      if (kit.harvest_project_id) {
        linked.push({
          kitProject: kit.name,
          harvestProject: '(already linked)',
          harvestId: kit.harvest_project_id,
        })
        continue
      }

      // Try to match by name, code, or client
      const nameL = (kit.name || '').toLowerCase()
      const codeL = (kit.project_code || '').toLowerCase()
      const clientL = (kit.client || '').toLowerCase()

      const match = harvestProjects.find((h) => {
        const hn = h.name.toLowerCase()
        const hc = h.code.toLowerCase()
        return (
          hn === nameL ||
          hn.includes(nameL) ||
          nameL.includes(hn) ||
          (codeL && hc === codeL) ||
          (clientL && hn.includes(clientL))
        )
      })

      if (match) {
        await db
.from('projects')
          .update({ harvest_project_id: match.id })
          .eq('id', kit.id)

        linked.push({
          kitProject: kit.name,
          harvestProject: match.name,
          harvestId: match.id,
        })
      } else {
        unmatched.push(kit.name)
      }
    }

    return ok(
      { linked: linked.length, unmatched, details: linked },
      `Synced ${linked.length} projects. ${unmatched.length} unmatched.`
    )
  },
}

// ─── kit_link_harvest_project ───────────────────────────────

export const linkHarvestProject: KitTool = {
  name: 'kit_link_harvest_project',
  description:
    'Manually link a Kit project to a specific Harvest project by ID. Use this when auto-sync cannot find the right match.',
  schema: z.object({
    workspace_id: z.string().uuid(),
    project_id: z.string().uuid().describe('Kit project ID'),
    harvest_project_id: z.number().int().describe('Harvest project ID'),
  }),
  handler: async ({ workspace_id, project_id, harvest_project_id }) => {
    const db = createAdminClient()
    const { data, error } = await db
.from('projects')
      .update({ harvest_project_id })
      .eq('workspace_id', workspace_id)
      .eq('id', project_id)
      .select('id, name, harvest_project_id')
      .single()

    if (error) return fail(error.message)
    return ok(data, `Linked "${data.name}" to Harvest project ${harvest_project_id}`)
  },
}
