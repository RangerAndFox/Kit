// @ts-nocheck
/**
 * Kit Access Control
 *
 * Three-tier permission system that gates what Kit shows to whom.
 * Enforced at TWO levels:
 *
 *   1. Gateway (Kit level) — blocks entire agent actions based on tier
 *   2. Agent level — filters sensitive fields from results
 *
 * Tiers:
 *   admin    → founder / owner — sees everything
 *   producer → producers / PMs — sees budgets, timelines, client info (not margins/rates)
 *   artist   → artists / editors / freelancers — project info, own time, deliverables only
 *
 * The user's tier is resolved from team_members.role + project_access.can_see_financials
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Types ──────────────────────────────────────────────────

export type AccessTier = 'admin' | 'producer' | 'artist'

export interface UserContext {
  /** Supabase team_member ID */
  teamMemberId: string
  /** Workspace ID */
  workspaceId: string
  /** Resolved access tier */
  tier: AccessTier
  /** Display name for denial messages */
  name: string
  /** Slack user ID (for identifying requests from Slack) */
  slackUserId?: string
  /** Per-project financial visibility overrides */
  projectFinancials?: Set<string>
}

export interface AccessCheck {
  allowed: boolean
  reason?: string
}

// ─── Tier Resolution ────────────────────────────────────────

const ROLE_TO_TIER: Record<string, AccessTier> = {
  founder: 'admin',
  producer: 'producer',
  artist: 'artist',
  freelancer: 'artist',
}

/**
 * Emails that always resolve to admin tier, even without a team_members row.
 * Why: founder access can't depend on the team_members table being seeded —
 * Steve must be able to talk to Kit before any other user is provisioned.
 */
const HARDCODED_ADMIN_EMAILS = new Set<string>([
  'steve@rangerandfox.tv',
  'jared@rangerandfox.tv',
])

function isHardcodedAdmin(email: string | undefined | null): boolean {
  return !!email && HARDCODED_ADMIN_EMAILS.has(email.toLowerCase())
}

/**
 * Resolve a user's access tier from their Slack user ID.
 * This is the primary entry point — Kit identifies users by Slack ID.
 *
 * If `email` is provided and matches a hardcoded admin (and no team_members
 * row exists for the slack user), returns a synthetic admin context.
 */
export async function resolveUserContext(
  workspaceId: string,
  slackUserId: string,
  email?: string,
): Promise<UserContext | null> {
  const db = createAdminClient()

  const { data: member, error } = await db
    .from('team_members')
    .select('id, role, display_name, name, email')
    .eq('workspace_id', workspaceId)
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  if (!error && member) {
    // Get project-level financial overrides
    const { data: accessOverrides } = await db
      .from('project_access')
      .select('project_id')
      .eq('team_member_id', member.id)
      .eq('can_see_financials', true)

    const projectFinancials = new Set(
      (accessOverrides || []).map((a: any) => a.project_id)
    )

    // Hardcoded admin override even if DB role disagrees
    const dbTier = ROLE_TO_TIER[member.role] || 'artist'
    const tier: AccessTier = isHardcodedAdmin(member.email) ? 'admin' : dbTier

    return {
      teamMemberId: member.id,
      workspaceId,
      tier,
      name: member.display_name || member.name || member.email,
      slackUserId,
      projectFinancials,
    }
  }

  // No team_members row — fall back to hardcoded admin if email matches
  if (isHardcodedAdmin(email)) {
    return {
      teamMemberId: `hardcoded:${email}`,
      workspaceId,
      tier: 'admin',
      name: email!,
      slackUserId,
      projectFinancials: new Set(),
    }
  }

  return null
}

// ─── Gateway Rules ──────────────────────────────────────────
// These define which agent:action pairs each tier can access.
// If an action isn't listed, it's allowed for everyone.

interface GatewayRule {
  /** Minimum tier required (admin > producer > artist) */
  minTier: AccessTier
  /** If true, also check project_access.can_see_financials for producers */
  requiresFinancialAccess?: boolean
}

const TIER_RANK: Record<AccessTier, number> = {
  admin: 3,
  producer: 2,
  artist: 1,
}

/**
 * Agent:action pairs that require elevated access.
 * Anything not listed here is open to all tiers.
 *
 * Security model: gating happens here BEFORE the agent runs. Field-level
 * scrub (filterResultData) is the defense-in-depth that strips sensitive
 * fields from anything that slips through.
 */
const GATEWAY_RULES: Record<string, GatewayRule> = {
  // ── Harvest ──────────────────────────────
  // log_time, find_projects, get_project_tasks → open to all (artists need
  // to log their own time + pick a project). Field-level filter strips
  // budget / client / dates / brief from project results before they reach
  // an artist's reply (see PRODUCER_FIELDS).
  'harvest:get_budget':         { minTier: 'producer', requiresFinancialAccess: true },
  'harvest:get_time_entries':   { minTier: 'producer' },
  'harvest:get_summary':        { minTier: 'producer' },
  'harvest:provision':          { minTier: 'producer' },
  'harvest:get_team':           { minTier: 'producer' },
  'harvest:get_contacts':       { minTier: 'producer' },

  // ── Dropbox ──────────────────────────────
  'dropbox:provision':          { minTier: 'producer' },

  // ── Frame.io ─────────────────────────────
  'frameio:provision':          { minTier: 'producer' },

  // ── Slack ────────────────────────────────
  'slack:provision':            { minTier: 'producer' },

  // ── Brain (entire surface — producer+) ──
  // Brains may contain client identifiers, budgets, contact info,
  // unresolved decisions, sensitive notes. Per locked v1 policy,
  // artists can't reach any brain action.
  'brain:get':                  { minTier: 'producer' },
  'brain:seed':                 { minTier: 'producer' },
  'brain:why':                  { minTier: 'producer' },
  'brain:refresh_canvas':       { minTier: 'producer' },

  // ── Studio Knowledge (entire surface — producer+) ──
  // RAG over project_summary / notes / transcripts / brain sections.
  // Anything in there can reference budgets, contacts, briefs, SOWs.
  // Artists can still pick projects to log time against via Harvest;
  // they just can't query the wider studio knowledge base.
  'studio_knowledge:search':            { minTier: 'producer' },
  'studio_knowledge:lookup_project':    { minTier: 'producer' },
  'studio_knowledge:lookup_client':     { minTier: 'producer' },
  'studio_knowledge:find_contact':      { minTier: 'producer' },
  'studio_knowledge:recent_projects':   { minTier: 'producer' },
  'studio_knowledge:recent_clients':    { minTier: 'producer' },
  'studio_knowledge:regenerate_summary':{ minTier: 'producer' },
  'studio_knowledge:reembed_all':       { minTier: 'admin' },
  'studio_knowledge:reembed_clients':   { minTier: 'admin' },
  'studio_knowledge:reembed_transcripts':{ minTier: 'admin' },
}

/**
 * Gateway check: can this user call this agent:action?
 * Returns { allowed: true } or { allowed: false, reason }.
 */
export function checkGateway(
  user: UserContext,
  agentId: string,
  action: string,
  projectId?: string
): AccessCheck {
  const key = `${agentId}:${action}`
  const rule = GATEWAY_RULES[key]

  // No rule → open to all
  if (!rule) return { allowed: true }

  // Check tier
  if (TIER_RANK[user.tier] < TIER_RANK[rule.minTier]) {
    return {
      allowed: false,
      reason: `Sorry, that's restricted information. You'd need ${rule.minTier}-level access for this.`,
    }
  }

  // Producer + financial access required → check project-level override
  if (
    rule.requiresFinancialAccess &&
    user.tier === 'producer' &&
    projectId &&
    !user.projectFinancials?.has(projectId)
  ) {
    return {
      allowed: false,
      reason: `Sorry, budget details for this project are restricted. Ask an admin to grant you financial access.`,
    }
  }

  return { allowed: true }
}

// ─── Field-Level Filtering ──────────────────────────────────
// Agents return full data. This strips sensitive fields based on tier.

/** Fields that should be removed for non-admin users */
const ADMIN_ONLY_FIELDS = new Set([
  'margin_target',
  'margin_percent',
  'profit_margin',
  'hourly_rate',
  'cost_rate',
  'markup',
  'sow_summary',
  'internal_notes',
])

/**
 * Fields that require at least producer tier.
 *
 * For artists this is the "name-only" cut: anything they shouldn't see
 * on a project record gets stripped. The whitelist (what survives) is
 * effectively: id, name, project_code, harvest_project_id, status —
 * enough to pick the right project for time entry, nothing more.
 */
const PRODUCER_FIELDS = new Set([
  // Financial
  'budget_total',
  'budget_spent',
  'budget_remaining',
  'budget',
  'revenue',
  'costs',
  'burn_rate',
  'invoice_total',
  // Client identity
  'client',
  'client_name',
  'client_email',
  'client_phone',
  'primary_contacts',
  // Dates / schedule (early conversations & deadlines reveal client context)
  'start_date',
  'end_date',
  'target_delivery',
  // Scope / context
  'brief_summary',
  'external_links',
  'notes',
  // Frame.io / Dropbox folder identifiers can leak client folder structure
  'frameio_url',
  'dropbox_url',
])

/**
 * Filter sensitive fields from agent result data based on user tier.
 * This is the agent-level defense — applied to result.data before
 * Kit shows it to the user.
 */
export function filterResultData(
  data: Record<string, unknown> | undefined,
  user: UserContext,
  projectId?: string
): Record<string, unknown> | undefined {
  if (!data) return data
  if (user.tier === 'admin') return data // admins see everything

  const filtered = { ...data }

  // Admin-only fields — strip for everyone below admin
  for (const field of ADMIN_ONLY_FIELDS) {
    if (field in filtered) {
      delete filtered[field]
    }
  }

  // Producer fields — strip for artists unless they have project-level override
  if (user.tier === 'artist') {
    const hasOverride = projectId && user.projectFinancials?.has(projectId)
    if (!hasOverride) {
      for (const field of PRODUCER_FIELDS) {
        if (field in filtered) {
          delete filtered[field]
        }
      }
    }
  }

  // Recursively filter nested objects (e.g., project lists)
  for (const [key, value] of Object.entries(filtered)) {
    if (Array.isArray(value)) {
      filtered[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? filterResultData(item as Record<string, unknown>, user, projectId)
          : item
      )
    } else if (typeof value === 'object' && value !== null) {
      filtered[key] = filterResultData(value as Record<string, unknown>, user, projectId)
    }
  }

  return filtered
}

// ─── Convenience ────────────────────────────────────────────

/**
 * Failsafe context for the rare case where a Slack user can't be resolved
 * to a team_members row AND isn't a hardcoded admin. Default to artist
 * tier so unknown users get the minimum permissions, never the maximum.
 *
 * Callers that detect a null context should pass this instead of bypassing
 * enforcement entirely.
 */
export function failsafeArtistContext(workspaceId: string, slackUserId: string): UserContext {
  return {
    teamMemberId: `unknown:${slackUserId}`,
    workspaceId,
    tier: 'artist',
    name: 'unknown user',
    slackUserId,
    projectFinancials: new Set(),
  }
}

/**
 * Full access check + field filtering in one call.
 * Used by the kit_ask_agent MCP tool.
 */
export async function enforceAccess(
  user: UserContext,
  agentId: string,
  action: string,
  payload: Record<string, unknown>,
  result: { success: boolean; data?: Record<string, unknown>; [key: string]: unknown }
): Promise<typeof result> {
  // Gateway check
  const projectId = payload.projectId as string | undefined
  const gatewayCheck = checkGateway(user, agentId, action, projectId)
  if (!gatewayCheck.allowed) {
    return {
      ...result,
      success: false,
      error: gatewayCheck.reason,
      data: undefined,
    }
  }

  // Field-level filtering on successful results
  if (result.success && result.data) {
    result.data = filterResultData(result.data, user, projectId)
  }

  return result
}
