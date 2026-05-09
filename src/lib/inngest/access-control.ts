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
 */
const GATEWAY_RULES: Record<string, GatewayRule> = {
  // ── Harvest ──────────────────────────────
  'harvest:get_budget':         { minTier: 'producer', requiresFinancialAccess: true },
  'harvest:provision':          { minTier: 'producer' },
  'harvest:get_team':           { minTier: 'producer' },
  // harvest:log_time → open to all (artists log their own time)
  // harvest:find_projects → open to all
  // harvest:get_project_tasks → open to all

  // ── Dropbox ──────────────────────────────
  'dropbox:provision':          { minTier: 'producer' },
  // dropbox:search → open to all
  // dropbox:list_folder → open to all
  // dropbox:get_share_link → open to all
  // dropbox:find_project_folder → open to all

  // ── Frame.io ─────────────────────────────
  'frameio:provision':          { minTier: 'producer' },
  // frameio:get_comments → open to all
  // frameio:get_project → open to all
  // frameio:list_assets → open to all
  // frameio:get_review_status → open to all

  // ── Slack ────────────────────────────────
  'slack:provision':            { minTier: 'producer' },
  // slack:send_message → open to all
  // slack:find_channel → open to all
  // slack:find_user → open to all
  // slack:set_topic → open to all (Slack has its own permissions)
  // slack:get_history → open to all
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

/** Fields that require at least producer tier */
const PRODUCER_FIELDS = new Set([
  'budget_total',
  'budget_spent',
  'budget_remaining',
  'revenue',
  'costs',
  'burn_rate',
  'client_email',
  'client_phone',
  'invoice_total',
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
