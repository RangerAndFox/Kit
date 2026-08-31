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
// unstated Vercel default. Most functions finish in under a minute, but the
// workbook-wide Sheet-to-Canvas repair deliberately paces Google Sheets reads
// below the per-user quota and can take several minutes when many projects need
// recovery at once. Inngest still isolates and retries the individual step.
export const maxDuration = 300

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: registeredFunctions,
})
