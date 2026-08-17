// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { registeredFunctions } from '@/lib/inngest/functions'

/**
 * Inngest API route.
 *
 * Inngest's serve() adapter handles:
 *   - Function registration (POST /api/inngest)
 *   - Step execution callbacks
 *   - Health checks
 *
 * All Kit Inngest functions are registered here.
 *
 * WHICH deployments may register them is decided by selectRegisteredFunctions
 * (see `@/lib/inngest/registration`): a Vercel Preview deployment registers
 * ZERO functions unless it sets KIT_INNGEST_ALLOW_PREVIEW=true, so preview code
 * can never be scheduled against the production Inngest environment. Production
 * and local development are unaffected.
 */

// Own the serverless execution limit for this route rather than inheriting an
// unstated Vercel default (which can be as low as 10-15s). The delivery specs
// scan bounds each tick to a ~30s elapsed budget; 60s leaves conservative
// headroom for a page or folder re-list already in flight. Matches the
// explicit-ownership convention used by the app's other heavy routes
// (mcp, slack/events = 60).
export const maxDuration = 60

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: registeredFunctions,
})
