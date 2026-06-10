/**
 * Compose and embed a client_profiles row as a project_documents RAG entry
 * so the studio_knowledge agent can answer questions like "who do we talk
 * to at Microsoft?", "what's our history with Nike?", etc.
 */

import { upsertDocument } from '../rag/ingest'
import { createAdminClient } from '../supabase/admin'

export interface ClientProfileInput {
  id: string
  workspace_id: string
  client_name: string
  primary_contacts: Array<{
    first_name?: string
    last_name?: string
    title?: string
    email?: string
    phone?: string
  }> | null
  payment_reliability: string | null
  scope_creep_tendency: string | null
  total_lifetime_revenue: number | null
  project_count: number | null
  notes: string | null
  harvest_client_id: number | null
}

export function composeClientProfileText(c: ClientProfileInput): { title: string; content: string } {
  const title = `Client · ${c.client_name}`
  const lines: string[] = []
  lines.push(`# ${title}`)
  if (c.project_count != null) lines.push(`Projects: ${c.project_count}`)
  if (c.total_lifetime_revenue != null) lines.push(`Lifetime revenue: $${c.total_lifetime_revenue}`)
  if (c.payment_reliability) lines.push(`Payment reliability: ${c.payment_reliability}`)
  if (c.scope_creep_tendency) lines.push(`Scope-creep tendency: ${c.scope_creep_tendency}`)
  if (c.harvest_client_id) lines.push(`Harvest client id: ${c.harvest_client_id}`)

  const contacts = c.primary_contacts || []
  if (contacts.length > 0) {
    lines.push('', '## Contacts')
    for (const ct of contacts) {
      const name = [ct.first_name, ct.last_name].filter(Boolean).join(' ').trim() || '(no name)'
      const bits: string[] = [`- *${name}*`]
      if (ct.title) bits.push(ct.title)
      if (ct.email) bits.push(ct.email)
      if (ct.phone) bits.push(ct.phone)
      lines.push(bits.join(' · '))
    }
  }

  if (c.notes?.trim()) {
    lines.push('', '## Notes', c.notes.trim())
  }

  return { title, content: lines.join('\n') }
}

export async function embedClientProfile(c: ClientProfileInput): Promise<{ documentId: string }> {
  const { title, content } = composeClientProfileText(c)
  return upsertDocument({
    workspaceId: c.workspace_id,
    projectId: null, // client docs are not project-scoped
    docType: 'client_profile',
    title,
    content,
    visibilityTier: 'team',
    metadata: {
      client_name: c.client_name,
      project_count: c.project_count,
      total_lifetime_revenue: c.total_lifetime_revenue,
      harvest_client_id: c.harvest_client_id,
      contact_count: (c.primary_contacts || []).length,
    },
  })
}

export async function embedAllClients(workspaceId: string): Promise<{ embedded: number; failed: number }> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('client_profiles')
    .select('id, workspace_id, client_name, primary_contacts, payment_reliability, scope_creep_tendency, total_lifetime_revenue, project_count, notes, harvest_client_id')
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`embedAllClients: ${error.message}`)
  let embedded = 0
  let failed = 0
  for (const c of data || []) {
    try {
      await embedClientProfile(c as any)
      embedded++
    } catch (err: any) {
      console.error(`[client-profile] embed failed for ${c.id}: ${err.message}`)
      failed++
    }
  }
  return { embedded, failed }
}
