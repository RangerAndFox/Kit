// @ts-nocheck
/**
 * Kit Agent System — Shared Types
 *
 * Every agent is a domain expert. It declares:
 *   - what it's an expert in (domain, description)
 *   - what it can do (capabilities with action names)
 *   - how to call it (handler per action)
 *
 * Kit uses these declarations to route requests to the right expert.
 */

// ─── Agent Result ──────────────────────────────────────────

/** Every agent action returns this shape — no exceptions. */
export interface AgentResult {
  agent: string
  action: string
  success: boolean
  data?: Record<string, unknown>
  url?: string
  id?: string
  error?: string
  message?: string
}

// ─── Agent Capability ──────────────────────────────────────

/** A single thing an agent can do */
export interface AgentCapability {
  /** Action identifier, e.g. "provision", "log_time", "search_files" */
  action: string
  /** Human-readable description of what this action does */
  description: string
  /** What kind of input this action expects */
  inputDescription?: string
  /** Whether this action modifies external state */
  mutates: boolean
}

// ─── Agent Definition ──────────────────────────────────────

/** Full agent registration */
export interface AgentDefinition {
  /** Unique agent ID, e.g. "harvest", "dropbox" */
  id: string
  /** Human name, e.g. "Harvest Agent" */
  name: string
  /** The external service/domain this agent owns */
  domain: string
  /** What this agent is an expert in — Kit reads this to decide who to ask */
  expertise: string
  /** Required env vars — agent is unavailable if any are missing */
  requiredEnvVars: string[]
  /** Everything this agent can do */
  capabilities: AgentCapability[]
  /** The handler — receives action name + payload, returns result */
  handler: (action: string, payload: Record<string, unknown>) => Promise<AgentResult>
}

// ─── Service Keys ──────────────────────────────────────────

export type ServiceKey =
  | 'harvest'
  | 'dropbox'
  | 'frameio'
  | 'canva'
  | 'figma'
  | 'slack'

export const ALL_SERVICE_KEYS: ServiceKey[] = [
  'harvest', 'dropbox', 'frameio', 'canva', 'figma', 'slack',
]

// ─── Provision Event Data ──────────────────────────────────
// (Kept for backward compat with the orchestrator)

export interface ProvisionEventData {
  projectId: string
  workspaceId: string
  projectName: string
  client: string
  projectCode?: string
  projectType?: string
  startDate?: string
  targetDelivery?: string
  briefSummary?: string
  budgetTotal?: number
  services: ServiceKey[]
  slackUserId?: string
  slackChannelId?: string
}
