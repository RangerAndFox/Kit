/**
 * Session Manager
 * 
 * Manages the lifecycle of Managed Agent sessions for Kit.
 * Handles creating sessions, sending messages, streaming responses,
 * and tracking session state in Supabase.
 */

import { getManagedAgentsClient, type AgentEvent, type SessionResponse } from './client'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/supabase'

// ─── Types ───────────────────────────────────────────────────

export interface SessionResult {
  sessionId: string
  events: AgentEvent[]
  status: 'completed' | 'error' | 'timeout'
  error?: string
}

export interface TriggerContext {
  workspaceId: string
  projectId?: string
  source: string
  payload: Record<string, unknown>
}

// ─── Session Manager ─────────────────────────────────────────

export class SessionManager {
  private _client: ReturnType<typeof getManagedAgentsClient> | null = null

  private get client() {
    if (!this._client) {
      this._client = getManagedAgentsClient()
    }
    return this._client
  }

  /**
   * Dispatch a task to a Managed Agent.
   * Creates a session, sends the trigger context as a message,
   * and streams the response events.
   */
  async dispatch(
    agentId: string,
    environmentId: string,
    trigger: TriggerContext,
    prompt: string
  ): Promise<SessionResult> {
    // Create the session
    const session = await this.client.createSession({
      agent: agentId,
      environment_id: environmentId,
      title: `${trigger.source} — ${new Date().toISOString()}`,
      metadata: {
        workspace_id: trigger.workspaceId,
        project_id: trigger.projectId || '',
        source: trigger.source,
      },
    })

    // Log session creation in Supabase
    await this.logSessionStart(session, trigger)

    // Send the trigger message
    await this.client.sendMessage(session.id, prompt)

    // Stream agent response events via SSE
    let events: AgentEvent[] = []
    let status: 'completed' | 'error' | 'timeout' = 'completed'
    let error: string | undefined

    try {
      events = await this.client.streamUntilDone(session.id)
      for (const event of events) {
        await this.handleEvent(session.id, event, trigger)
      }
    } catch (err) {
      status = 'error'
      error = err instanceof Error ? err.message : String(err)
    }

    // Log session completion
    await this.logSessionEnd(session.id, status, events.length, error)

    return { sessionId: session.id, events, status, error }
  }

  /**
   * Send a follow-up message to an existing session.
   * Used for conversational agents like the Slack participant.
   */
  async sendFollowUp(sessionId: string, message: string): Promise<AgentEvent[]> {
    await this.client.sendMessage(sessionId, message)
    return this.client.streamUntilDone(sessionId)
  }

  /**
   * Fetch current event IDs for a session to use as a baseline before sending a message.
   */
  private async snapshotEventIds(sessionId: string): Promise<Set<string>> {
    try {
      const res = await this.client.listEvents(sessionId, { limit: 100, order: 'asc' })
      const ids = new Set<string>()
      for (const evt of res.data || []) {
        const id = (evt as any).id || `${(evt as any).type}-${(evt as any).created_at || ''}`
        ids.add(id)
      }
      return ids
    } catch {
      return new Set<string>()
    }
  }

  /**
   * Check if a session is still active.
   */
  async isActive(sessionId: string): Promise<boolean> {
    try {
      const session = await this.client.getSession(sessionId)
      return session.status === 'active' || session.status === 'waiting'
    } catch {
      return false
    }
  }

  /**
   * Get or create a persistent session for a given context key.
   * Used for long-lived sessions like Slack channel participants.
   */
  async getOrCreateSession(
    contextKey: string,
    agentId: string,
    environmentId: string,
    trigger: TriggerContext
  ): Promise<string> {
    const supabase = createAdminClient()

    // Check for existing active session
    const { data: existing } = await supabase
      .from('managed_agent_sessions')
      .select('session_id, status')
      .eq('workspace_id', trigger.workspaceId)
      .eq('context_key', contextKey)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (existing?.session_id) {
      // Verify it's still alive on Anthropic's side
      const active = await this.isActive(existing.session_id)
      if (active) return existing.session_id
      await supabase
        .from('managed_agent_sessions')
        .update({ status: 'closed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('session_id', existing.session_id)
    }

    // Create new session
    const session = await this.client.createSession({
      agent: agentId,
      environment_id: environmentId,
      title: contextKey,
      metadata: {
        workspace_id: trigger.workspaceId,
        context_key: contextKey,
        source: trigger.source,
      },
    })

    // Track it in the provider-session ledger. Aggregate sweeps continue to
    // use agent_runs; provider session identity belongs here.
    const { error: insertError } = await supabase.from('managed_agent_sessions').insert({
      workspace_id: trigger.workspaceId,
      project_id: trigger.projectId ?? null,
      session_id: session.id,
      agent_id: agentId,
      environment_id: environmentId,
      context_key: contextKey,
      source: trigger.source,
      status: 'active',
      started_at: new Date().toISOString(),
      metadata: trigger.payload as unknown as Json,
    })
    if (insertError) throw new Error(`Failed to persist managed-agent session: ${insertError.message}`)

    return session.id
  }

  // ─── Event Handling ────────────────────────────────────────

  private async handleEvent(
    sessionId: string,
    event: AgentEvent,
    trigger: TriggerContext
  ): Promise<void> {
    // Agents write results back to Supabase via MCP tools,
    // but we can also react to specific event types here
    // for real-time UI updates (e.g., pushing to dashboard via SSE)

    if (event.type === 'agent.tool_use' || event.type === 'agent.message') {
      // Could emit to a real-time channel for the frontend
      // e.g., Supabase Realtime or a WebSocket
    }
  }

  // ─── Logging ───────────────────────────────────────────────

  private async logSessionStart(
    session: SessionResponse,
    trigger: TriggerContext
  ): Promise<void> {
    const supabase = createAdminClient()
    const { error } = await supabase.from('managed_agent_sessions').insert({
      workspace_id: trigger.workspaceId,
      project_id: trigger.projectId ?? null,
      session_id: session.id,
      agent_id: session.agent,
      environment_id: session.environment_id,
      source: trigger.source,
      status: 'running',
      started_at: new Date().toISOString(),
      metadata: trigger.payload as unknown as Json,
    })
    if (error) throw new Error(`Failed to log managed-agent session: ${error.message}`)
  }

  private async logSessionEnd(
    sessionId: string,
    status: string,
    eventCount: number,
    error?: string
  ): Promise<void> {
    const supabase = createAdminClient()
    const { error: updateError } = await supabase
      .from('managed_agent_sessions')
      .update({
        status,
        completed_at: new Date().toISOString(),
        event_count: eventCount,
        error: error || null,
        updated_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId)
    if (updateError) throw new Error(`Failed to complete managed-agent session: ${updateError.message}`)
  }
}

// ─── Singleton ───────────────────────────────────────────────

let _manager: SessionManager | null = null

export function getSessionManager(): SessionManager {
  if (!_manager) {
    _manager = new SessionManager()
  }
  return _manager
}
