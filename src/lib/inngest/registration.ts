/**
 * Which Inngest functions a given deployment is allowed to register.
 *
 * ENVIRONMENT BOUNDARY (fail-closed). Kit's Inngest app id is a constant
 * (`kit`) and the environment it joins is decided purely by the injected
 * INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY. With no INNGEST_ENV configured, ANY
 * deployment that boots with the production keys registers as the same app in
 * the PRODUCTION Inngest environment — so Vercel Preview deployments were being
 * invoked on production cron schedules and executed scheduled work with
 * production credentials (verified in production: stale previews refreshing
 * Frame.io/Adobe tokens, reading production Supabase, and consuming the Dropbox
 * rate limit).
 *
 * This selector is defense in depth: a Preview deployment registers NOTHING
 * unless it explicitly opts in. Credential scoping (Inngest keys restricted to
 * the Production environment in Vercel) remains the real boundary — app naming
 * is never the boundary.
 *
 * Matrix:
 *   VERCEL_ENV=production  -> all functions (production owns the schedules)
 *   VERCEL_ENV=preview     -> NONE, unless KIT_INNGEST_ALLOW_PREVIEW === 'true'
 *   VERCEL_ENV unset       -> all functions (local dev / non-Vercel runtimes)
 *
 * VERCEL_ENV is the boundary, deliberately NOT NODE_ENV: NODE_ENV is
 * 'production' for preview builds too, so it cannot separate preview from
 * production. The preview opt-in must only ever be set on the specific preview
 * deployment that needs it — never in shared/production project settings.
 */

/**
 * Exactly the environment this decision reads — nothing else affects it. The
 * index signature keeps `process.env` (and test doubles carrying unrelated
 * vars) assignable; only the two named vars are ever consulted.
 */
export interface RegistrationEnv {
  /** Vercel's deployment target: 'production' | 'preview' | 'development'. */
  VERCEL_ENV?: string
  /** Per-deployment preview opt-in; must be the exact string 'true'. */
  KIT_INNGEST_ALLOW_PREVIEW?: string
  [key: string]: string | undefined
}

/** True when this deployment is a Vercel Preview that has not opted in. */
export function isPreviewRegistrationBlocked(env: RegistrationEnv = process.env): boolean {
  const allowPreview = env.KIT_INNGEST_ALLOW_PREVIEW === 'true'
  return env.VERCEL_ENV === 'preview' && !allowPreview
}

/**
 * The function list this deployment may serve. Returns the caller's array
 * unchanged everywhere except a non-opted-in Preview deployment, which gets an
 * empty list (registers zero functions, so Inngest schedules nothing against
 * it). Pure — takes `env` for testability.
 */
export function selectRegisteredFunctions<T>(
  all: readonly T[],
  env: RegistrationEnv = process.env,
): readonly T[] {
  return isPreviewRegistrationBlocked(env) ? [] : all
}
