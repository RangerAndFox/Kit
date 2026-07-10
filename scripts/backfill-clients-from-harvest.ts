// @ts-nocheck
/**
 * One-shot Harvest → client_profiles + contacts backfill.
 *
 * Pulls every client + every contact from Harvest, upserts client_profiles
 * keyed on harvest_client_id, derives project_count + total_lifetime_revenue
 * from the local `projects` table, then embeds each client as a
 * project_documents row.
 *
 * Idempotent. Run with:
 *   npx tsx scripts/backfill-clients-from-harvest.ts
 */

import { createAdminClient } from '../src/lib/supabase/admin'
import { embedAllClients } from '../src/lib/studio-knowledge/client-profile'
import { harvestRequest } from './harvest-fetch'

interface HarvestClient {
  id: number
  name: string
  is_active: boolean
  address?: string
  currency?: string
}

interface HarvestContact {
  id: number
  client: { id: number; name: string }
  title?: string
  first_name?: string
  last_name?: string
  email?: string
  phone_office?: string
  phone_mobile?: string
}


async function listAll(path: string, key: string): Promise<any[]> {
  const out: any[] = []
  let page = 1
  while (true) {
    const data = await harvestRequest(`${path}?per_page=100&page=${page}`)
    out.push(...(data[key] || []))
    if (!data.next_page) break
    page = data.next_page
  }
  return out
}

async function deriveStats(workspaceId: string, sb: any): Promise<Map<string, { count: number; budget: number }>> {
  // Aggregate per-client_name from the local projects table.
  const { data } = await sb
    .from('projects')
    .select('client, budget_total')
    .eq('workspace_id', workspaceId)
  const stats = new Map<string, { count: number; budget: number }>()
  for (const p of data || []) {
    if (!p.client) continue
    const cur = stats.get(p.client) || { count: 0, budget: 0 }
    cur.count++
    if (typeof p.budget_total === 'number') cur.budget += p.budget_total
    stats.set(p.client, cur)
  }
  return stats
}

async function main() {
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) throw new Error('KIT_DEFAULT_WORKSPACE_ID required')

  console.log('Pulling Harvest clients + contacts...')
  const [clients, contacts] = await Promise.all([
    listAll('/clients', 'clients') as Promise<HarvestClient[]>,
    listAll('/contacts', 'contacts') as Promise<HarvestContact[]>,
  ])
  console.log(`  ${clients.length} clients, ${contacts.length} contacts.`)

  // Group contacts by client.id
  const byClient: Map<number, HarvestContact[]> = new Map()
  for (const ct of contacts) {
    if (!ct.client?.id) continue
    const arr = byClient.get(ct.client.id) || []
    arr.push(ct)
    byClient.set(ct.client.id, arr)
  }

  const sb = createAdminClient()
  const stats = await deriveStats(workspaceId, sb)

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const c of clients) {
    const localContacts = (byClient.get(c.id) || []).map((ct) => ({
      first_name: ct.first_name || '',
      last_name: ct.last_name || '',
      title: ct.title || '',
      email: ct.email || '',
      phone: ct.phone_office || ct.phone_mobile || '',
    }))

    const localStats = stats.get(c.name) || { count: 0, budget: 0 }

    const { data: existing } = await sb
      .from('client_profiles')
      .select('id')
      .eq('harvest_client_id', c.id)
      .maybeSingle()

    const row: any = {
      workspace_id: workspaceId,
      client_name: c.name,
      primary_contacts: localContacts,
      project_count: localStats.count,
      total_lifetime_revenue: localStats.budget,
      harvest_client_id: c.id,
      updated_at: new Date().toISOString(),
    }

    if (existing?.id) {
      const { error } = await sb.from('client_profiles').update(row).eq('id', existing.id)
      if (error) {
        console.warn(`  update failed for ${c.name}: ${error.message}`)
        skipped++
      } else updated++
    } else {
      const { error } = await sb.from('client_profiles').insert(row)
      if (error) {
        console.warn(`  insert failed for ${c.name}: ${error.message}`)
        skipped++
      } else inserted++
    }
  }

  console.log(`Clients: ${inserted} inserted, ${updated} updated, ${skipped} skipped.`)

  console.log('Embedding all clients into RAG...')
  const embedStats = await embedAllClients(workspaceId)
  console.log(`  Embedded: ${embedStats.embedded}, failed: ${embedStats.failed}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
