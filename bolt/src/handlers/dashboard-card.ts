export const KIT_PRODUCTION_DASHBOARD_URL =
  'https://kit-steve-rangerandfoxs-projects.vercel.app'

/**
 * Railway runs the Slack bot, while Vercel hosts the Control Center. Prefer an
 * explicit environment override, but keep Kit's verified production alias as
 * a fail-safe so a missing Railway variable cannot strand the Slack card.
 */
export function dashboardBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const candidate of [
    env.KIT_DASHBOARD_URL,
    env.NEXT_PUBLIC_APP_URL,
    KIT_PRODUCTION_DASHBOARD_URL,
  ]) {
    const value = String(candidate || '').trim().replace(/\/$/, '')
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) {
        return url.toString().replace(/\/$/, '')
      }
    } catch {
      // Ignore a malformed override and continue to the verified fallback.
    }
  }
  return KIT_PRODUCTION_DASHBOARD_URL
}

