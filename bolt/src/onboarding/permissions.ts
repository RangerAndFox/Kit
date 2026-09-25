/**
 * Use the same authoritative team_members tier as the execution gate.
 * A legacy staff role must not offer a flow that execution will reject, or
 * grant a CD producer-level financial permissions as a side effect.
 */

const ALLOWED_TIERS = ['admin', 'producer']

async function tierAllows(slackUserId: string, email?: string): Promise<boolean> {
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) return false
  try {
    const { resolveUserContext } = await import('../../../src/lib/inngest/access-control')
    const ctx = await resolveUserContext(workspaceId, slackUserId, email)
    if (!ctx) return false
    return ALLOWED_TIERS.includes(ctx.tier)
  } catch (err: any) {
    console.warn(`[onboarding] tierAllows failed: ${err?.message || err}`)
    return false
  }
}

export async function canOnboard(
  slackUserId: string,
  opts: { email?: string } = {},
): Promise<boolean> {
  return tierAllows(slackUserId, opts.email)
}
