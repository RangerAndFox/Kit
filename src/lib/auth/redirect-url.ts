export const KIT_PRODUCTION_APP_URL =
  'https://kit-steve-rangerandfoxs-projects.vercel.app'

const normalizeUrl = (candidate: string | undefined): string | null => {
  const value = String(candidate || '').trim().replace(/\/$/, '')
  if (!value) return null
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
      return null
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * Auth links must always return to the public Kit app in production. Vercel's
 * project URL is preferred over NEXT_PUBLIC_APP_URL because the latter was
 * historically set to localhost in production.
 */
export function authRedirectBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = normalizeUrl(env.KIT_AUTH_REDIRECT_URL)
  if (explicit) return explicit

  const vercelProduction = normalizeUrl(env.VERCEL_PROJECT_PRODUCTION_URL)
  if (vercelProduction) return vercelProduction

  const publicApp = normalizeUrl(env.NEXT_PUBLIC_APP_URL)
  if (publicApp && !(env.NODE_ENV === 'production' && new URL(publicApp).hostname === 'localhost')) {
    return publicApp
  }

  return KIT_PRODUCTION_APP_URL
}

