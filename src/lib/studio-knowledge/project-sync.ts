/**
 * Harvest → Supabase project reconciliation.
 *
 * The `projects` table drifts from Harvest: projects created directly in
 * Harvest (internal work) never land in Supabase, and almost every existing
 * row has a null harvest_project_id — so the old backfill (which matched on
 * harvest_project_id) would have matched nothing and inserted a full set of
 * duplicates.
 *
 * This reconciles on the PROJECT NUMBER (e.g. "2630a", "2540b") instead:
 *   - a Harvest project whose number matches no Supabase row  → INSERT
 *   - matches exactly one row with a null harvest_project_id   → LINK (backfill
 *     the id only; never touch the name/client/status a human or the modal set)
 *   - matches one row already linked to the same Harvest id    → already linked
 *   - matches more than one row, or a row linked to a DIFFERENT
 *     Harvest id                                               → AMBIGUOUS, skip
 *
 * Never inserts a duplicate (any number match blocks the insert) and never
 * clobbers existing fields. The planning half is pure + unit-tested.
 */

import { createAdminClient } from '../supabase/admin'
import { listProjects } from '../harvest/client'

/** Extract the studio project number ("2630a", "2540b", "2611") from a code
 * or name. Prefers a clean code; lowercased. Null when there's no number. */
export function projectNumberKey(s: string | null | undefined): string | null {
  if (!s) return null
  const m = String(s).match(/(\d{3,4}[a-z]?)/i)
  return m ? m[1].toLowerCase() : null
}

export interface ExistingRow {
  id: string
  project_code: string | null
  name: string | null
  harvest_project_id: number | null
}

export interface HarvestProj {
  id: number
  name: string
  code: string
  is_active: boolean
  client?: { id: number; name: string }
}

export interface SyncPlan {
  toInsert: { harvestId: number; name: string; client: string | null; code: string | null; status: string }[]
  toLink: { supabaseId: string; harvestId: number; name: string | null; code: string | null }[]
  ambiguous: { key: string; harvest: string; reason: string }[]
  alreadyLinked: number
}

/**
 * Pure: decide, for each Harvest project, whether to insert / link / skip
 * against the current Supabase rows. No I/O — unit-tested.
 */
export function planProjectSync(harvest: HarvestProj[], existing: ExistingRow[]): SyncPlan {
  const byKey = new Map<string, ExistingRow[]>()
  for (const r of existing) {
    const k = projectNumberKey(r.project_code) || projectNumberKey(r.name)
    if (!k) continue
    const list = byKey.get(k)
    if (list) list.push(r)
    else byKey.set(k, [r])
  }

  const plan: SyncPlan = { toInsert: [], toLink: [], ambiguous: [], alreadyLinked: 0 }

  for (const hp of harvest) {
    const key = projectNumberKey(hp.code) || projectNumberKey(hp.name)
    if (!key) {
      plan.ambiguous.push({ key: '(none)', harvest: hp.name, reason: 'no project number found in Harvest code/name' })
      continue
    }
    const matches = byKey.get(key) || []
    if (matches.length === 0) {
      plan.toInsert.push({
        harvestId: hp.id,
        name: hp.name,
        client: hp.client?.name ?? null,
        code: hp.code || null,
        status: hp.is_active ? 'active' : 'archived',
      })
    } else if (matches.length === 1) {
      const m = matches[0]
      if (m.harvest_project_id === hp.id) {
        plan.alreadyLinked++
      } else if (m.harvest_project_id == null) {
        plan.toLink.push({ supabaseId: m.id, harvestId: hp.id, name: m.name, code: m.project_code })
      } else {
        plan.ambiguous.push({
          key,
          harvest: hp.name,
          reason: `Supabase "${m.name}" (${m.project_code}) is already linked to Harvest #${m.harvest_project_id}`,
        })
      }
    } else {
      plan.ambiguous.push({
        key,
        harvest: hp.name,
        reason: `${matches.length} Supabase rows share number ${key}: ${matches.map((m) => m.project_code || m.name).join(', ')}`,
      })
    }
  }

  return plan
}

export interface SyncResult extends SyncPlan {
  dryRun: boolean
  inserted: number
  linked: number
}

/**
 * Reconcile the Harvest project list into Supabase. `dryRun` computes the plan
 * without writing. Admin-triggered via `/kit sync-projects [run]`.
 */
export async function syncProjectsFromHarvest(opts: { dryRun: boolean }): Promise<SyncResult> {
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) throw new Error('KIT_DEFAULT_WORKSPACE_ID not set')

  const harvest = (await listProjects(false)) as unknown as HarvestProj[]
  const sb = createAdminClient()
  const { data: existing, error } = await sb
    .from('projects')
    .select('id, project_code, name, harvest_project_id')
  if (error) throw new Error(`load projects: ${error.message}`)

  const plan = planProjectSync(harvest, (existing as ExistingRow[]) || [])
  if (opts.dryRun) return { ...plan, dryRun: true, inserted: 0, linked: 0 }

  let inserted = 0
  for (const ins of plan.toInsert) {
    const { error: e } = await sb.from('projects').insert({
      workspace_id: workspaceId,
      name: ins.name,
      client: ins.client,
      project_code: ins.code,
      status: ins.status,
      harvest_project_id: ins.harvestId,
    } as any)
    if (!e) inserted++
    else console.warn(`[sync-projects] insert ${ins.code} failed: ${e.message}`)
  }

  let linked = 0
  for (const lk of plan.toLink) {
    // Guard on still-null so a concurrent write can't be clobbered.
    const { error: e } = await sb
      .from('projects')
      .update({ harvest_project_id: lk.harvestId, updated_at: new Date().toISOString() })
      .eq('id', lk.supabaseId)
      .is('harvest_project_id', null)
    if (!e) linked++
    else console.warn(`[sync-projects] link ${lk.code} failed: ${e.message}`)
  }

  return { ...plan, dryRun: false, inserted, linked }
}
