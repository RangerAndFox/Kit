/**
 * Studio Knowledge agent — answers questions about the studio's project
 * history, contacts, budgets, and freeform notes via semantic RAG search
 * over project_documents + structured project lookups.
 */

import type { AgentDefinition, AgentResult } from './types'
import { searchDocuments, buildContext } from '../../rag/query'
import { createAdminClient } from '../../supabase/admin'
import { brainFirstRetrieve, buildSourcedContext } from '../../brain/retrieve'

async function handle(action: string, payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    switch (action) {
      case 'search': {
        const query = String(payload.query || '').trim()
        if (!query) return { agent: 'studio_knowledge', action, success: false, error: 'query is empty' }
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID || null
        const projectId = (payload.projectId as string) || null
        const channelId = (payload.channelId as string) || null
        const limit = Number(payload.limit) || 10

        // Brain-first when a channelId is available — the brain's own
        // sections rank ahead of generic project_documents, and the
        // result carries a Sources: line + structured provenance refs.
        if (channelId && workspaceId) {
          const first = await brainFirstRetrieve({ query, channelId, workspaceId, limit })
          const sourced = buildSourcedContext(first)
          return {
            agent: 'studio_knowledge',
            action,
            success: true,
            data: {
              results: first.results,
              context: sourced.context,
              sources_line: sourced.sourcesLine,
              provenances: sourced.provenances,
              brain_id: first.brainId,
            },
          }
        }

        const results = await searchDocuments(query, { workspaceId, projectId, limit })
        const context = buildContext(results)
        return {
          agent: 'studio_knowledge',
          action,
          success: true,
          data: { results, context },
        }
      }
      case 'lookup_project': {
        const query = String(payload.query || payload.code || payload.name || '').trim()
        if (!query) return { agent: 'studio_knowledge', action, success: false, error: 'query/code/name required' }
        const sb = createAdminClient()
        // Try exact project_code match first, then ilike on name/client/code
        const { data: exact } = await sb
          .from('projects')
          .select('*')
          .eq('project_code', query)
          .maybeSingle()
        if (exact) return { agent: 'studio_knowledge', action, success: true, data: { matches: [exact] } }

        const { data: fuzzy } = await sb
          .from('projects')
          .select('*')
          .or(`name.ilike.%${query}%,client.ilike.%${query}%,project_code.ilike.%${query}%`)
          .limit(10)
        return { agent: 'studio_knowledge', action, success: true, data: { matches: fuzzy || [] } }
      }
      case 'recent_projects': {
        const limit = Number(payload.limit) || 15
        const sb = createAdminClient()
        const { data } = await sb
          .from('projects')
          .select('id, name, client, project_code, status, budget_total, start_date, target_delivery')
          .order('start_date', { ascending: false, nullsFirst: false })
          .limit(limit)
        return { agent: 'studio_knowledge', action, success: true, data: data || [] }
      }
      case 'reembed_all': {
        // Manual trigger to refresh all project embeddings. Heavy — only run
        // when project data shape changes or after a bulk backfill.
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) return { agent: 'studio_knowledge', action, success: false, error: 'KIT_DEFAULT_WORKSPACE_ID required' }
        const { embedAllProjects } = await import('../../studio-knowledge/project-summary')
        const stats = await embedAllProjects(workspaceId)
        return { agent: 'studio_knowledge', action, success: true, data: stats }
      }
      case 'lookup_client': {
        const query = String(payload.query || payload.name || '').trim()
        if (!query) return { agent: 'studio_knowledge', action, success: false, error: 'query/name required' }
        const sb = createAdminClient()
        // Exact match on client_name first, then ilike.
        const { data: exact } = await sb
          .from('client_profiles')
          .select('*')
          .eq('client_name', query)
          .maybeSingle()
        if (exact) return { agent: 'studio_knowledge', action, success: true, data: { matches: [exact] } }

        const { data: fuzzy } = await sb
          .from('client_profiles')
          .select('*')
          .ilike('client_name', `%${query}%`)
          .limit(10)
        return { agent: 'studio_knowledge', action, success: true, data: { matches: fuzzy || [] } }
      }
      case 'find_contact': {
        const query = String(payload.query || payload.name || payload.email || '').trim()
        if (!query) return { agent: 'studio_knowledge', action, success: false, error: 'query/name/email required' }
        const sb = createAdminClient()
        // Pull all clients with contacts, filter in JS — primary_contacts is jsonb
        // and PostgREST jsonb querying is awkward for "any contact matches".
        const { data: clients } = await sb
          .from('client_profiles')
          .select('id, client_name, primary_contacts')
          .not('primary_contacts', 'is', null)
        const needle = query.toLowerCase()
        const hits: any[] = []
        for (const c of clients || []) {
          for (const ct of (c.primary_contacts as any[]) || []) {
            const name = `${ct.first_name || ''} ${ct.last_name || ''}`.toLowerCase()
            const email = String(ct.email || '').toLowerCase()
            const title = String(ct.title || '').toLowerCase()
            if (name.includes(needle) || email.includes(needle) || title.includes(needle)) {
              hits.push({ client_id: c.id, client_name: c.client_name, contact: ct })
            }
          }
          if (hits.length >= 25) break // soft cap
        }
        return { agent: 'studio_knowledge', action, success: true, data: { matches: hits } }
      }
      case 'recent_clients': {
        const limit = Number(payload.limit) || 15
        const sb = createAdminClient()
        const { data } = await sb
          .from('client_profiles')
          .select('id, client_name, project_count, total_lifetime_revenue, health_score, payment_reliability')
          .order('total_lifetime_revenue', { ascending: false, nullsFirst: false })
          .limit(limit)
        return { agent: 'studio_knowledge', action, success: true, data: data || [] }
      }
      case 'reembed_clients': {
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) return { agent: 'studio_knowledge', action, success: false, error: 'KIT_DEFAULT_WORKSPACE_ID required' }
        const { embedAllClients } = await import('../../studio-knowledge/client-profile')
        const stats = await embedAllClients(workspaceId)
        return { agent: 'studio_knowledge', action, success: true, data: stats }
      }
      case 'reembed_transcripts': {
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) return { agent: 'studio_knowledge', action, success: false, error: 'KIT_DEFAULT_WORKSPACE_ID required' }
        const { backfillTranscriptsIntoRag } = await import('../../studio-knowledge/transcript')
        const stats = await backfillTranscriptsIntoRag(workspaceId)
        return { agent: 'studio_knowledge', action, success: true, data: stats }
      }
      case 'regenerate_summary': {
        const projectId = (payload.projectId as string) || ''
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) return { agent: 'studio_knowledge', action, success: false, error: 'KIT_DEFAULT_WORKSPACE_ID required' }
        const { regenerateProjectSummary, regenerateAllProjectSummaries } = await import('../../studio-knowledge/auto-summarize')
        if (projectId) {
          const result = await regenerateProjectSummary(workspaceId, projectId)
          return { agent: 'studio_knowledge', action, success: true, data: result }
        }
        const stats = await regenerateAllProjectSummaries(workspaceId)
        return { agent: 'studio_knowledge', action, success: true, data: stats }
      }
      default:
        return { agent: 'studio_knowledge', action, success: false, error: `unknown action: ${action}` }
    }
  } catch (err: any) {
    return { agent: 'studio_knowledge', action, success: false, error: err?.message || String(err) }
  }
}

export const studioKnowledgeAgent: AgentDefinition = {
  id: 'studio_knowledge',
  name: 'Studio Knowledge',
  domain: 'studio history, projects, contacts, budgets, notes',
  expertise:
    "Answers natural-language questions about Ranger & Fox's project history, contacts, budgets, and any freeform notes. Use this for ANY question that references the studio's institutional knowledge — past projects, who worked on what, what we charged, what the brief said, who the contacts were. Returns a context block built from semantic search results that you should quote from when answering.",
  requiredEnvVars: ['OPENAI_API_KEY'],
  capabilities: [
    {
      action: 'search',
      description: 'Semantic search across embedded project summaries, briefs, notes, contacts. Returns the top matching documents as a context block.',
      inputDescription: 'query (string, required); optional projectId (uuid), limit (default 10)',
      mutates: false,
    },
    {
      action: 'lookup_project',
      description: 'Structured lookup of a project by project_code, exact name, or fuzzy text match on name/client/code.',
      inputDescription: 'query OR code OR name (string)',
      mutates: false,
    },
    {
      action: 'recent_projects',
      description: 'List recent projects (most-recent start_date first). Default 15.',
      inputDescription: 'limit (number, optional)',
      mutates: false,
    },
    {
      action: 'reembed_all',
      description: 'Re-embed every project in the workspace into project_documents. Heavy operation; run after backfill or schema changes.',
      inputDescription: 'workspaceId (optional; defaults to KIT_DEFAULT_WORKSPACE_ID)',
      mutates: true,
    },
    {
      action: 'lookup_client',
      description: 'Structured lookup of a client by name (exact match → ilike fuzzy). Returns matching client_profiles rows with full contacts + history.',
      inputDescription: 'query OR name (string)',
      mutates: false,
    },
    {
      action: 'find_contact',
      description: 'Find a person across all clients by name, email, or title. Returns matches with their client and full contact card.',
      inputDescription: 'query OR name OR email (string)',
      mutates: false,
    },
    {
      action: 'recent_clients',
      description: 'List clients ordered by total lifetime revenue (highest first). Default 15.',
      inputDescription: 'limit (number, optional)',
      mutates: false,
    },
    {
      action: 'reembed_clients',
      description: 'Re-embed every client_profiles row into the RAG store. Heavy; run after a contacts backfill.',
      inputDescription: 'workspaceId (optional; defaults to KIT_DEFAULT_WORKSPACE_ID)',
      mutates: true,
    },
    {
      action: 'reembed_transcripts',
      description: 'Embed any ingested call_transcripts that don\'t have a corresponding project_documents row yet. Idempotent.',
      inputDescription: 'workspaceId (optional; defaults to KIT_DEFAULT_WORKSPACE_ID)',
      mutates: true,
    },
    {
      action: 'regenerate_summary',
      description: 'Regenerate the Claude-written 1-pager summary for one project (pass projectId) or every project in the workspace. Pulls latest notes/transcripts/actions, writes via Haiku, replaces the project_summary doc.',
      inputDescription: 'projectId (uuid, optional — omit to regenerate ALL); workspaceId (optional)',
      mutates: true,
    },
  ],
  handler: handle,
}
