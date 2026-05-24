// @ts-nocheck
/**
 * Studio Knowledge agent — answers questions about the studio's project
 * history, contacts, budgets, and freeform notes via semantic RAG search
 * over project_documents + structured project lookups.
 */

import type { AgentDefinition, AgentResult } from './types'
import { searchDocuments, buildContext } from '../../rag/query'
import { createAdminClient } from '../../supabase/admin'

async function handle(action: string, payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    switch (action) {
      case 'search': {
        const query = String(payload.query || '').trim()
        if (!query) return { agent: 'studio_knowledge', action, success: false, error: 'query is empty' }
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID || null
        const projectId = (payload.projectId as string) || null
        const limit = Number(payload.limit) || 10
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
  ],
  handler: handle,
}
