export function behanceProfileSlugFromHref(value?: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value, 'https://www.behance.net')
    if (!/(^|\.)behance\.net$/i.test(url.hostname)) return null
    const slug = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || null
    if (!slug || new Set(['activity', 'auth', 'featured', 'gallery', 'hire', 'joblist', 'messages', 'misc', 'onboarding', 'portfolio', 'pro', 'search', 'settings']).has(slug)) return null
    return slug
  } catch {
    return null
  }
}

export function behanceUsernameFromState(value: string): string | null {
  return value.match(/"loggedInUser":\{"id":\d+,"first_name":"[^"]*","last_name":"[^"]*","username":"([^"]+)"/)?.[1]?.toLowerCase() || null
}

export interface BehanceIdentity {
  signedIn: boolean
  profileSlug: string | null
  expectedProfileSlug: string
}

export function behanceIdentityError(identity: BehanceIdentity): string | null {
  if (!identity.signedIn) return 'The dedicated browser is signed out of Behance. Run `npm run login` on the studio Mac.'
  if (!identity.profileSlug) return `Kit could not verify that the dedicated Behance browser is @${identity.expectedProfileSlug}. Run \`npm run login\` on the studio Mac.`
  if (identity.profileSlug !== identity.expectedProfileSlug) return `The dedicated Behance browser is signed in as @${identity.profileSlug}, but Kit requires @${identity.expectedProfileSlug}. Run \`npm run login\` on the studio Mac and switch accounts.`
  return null
}
