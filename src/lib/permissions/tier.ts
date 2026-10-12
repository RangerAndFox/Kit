/** Persisted, administrator-controlled role fields only. Never use model input. */
export function memberAccessTier(role: string, permissionTier?: string | null): 'admin' | 'producer' | 'artist' {
  if (['admin', 'owner', 'founder'].includes(role) || permissionTier === 'founder') return 'admin'
  if (['producer', 'cd', 'creative_director'].includes(role) || permissionTier === 'producer') return 'producer'
  return 'artist'
}

/** Keep job titles and permission tiers valid under their separate DB enums. */
export function roleAssignment(role: string): { role: string; permission_tier: string } {
  if (['admin', 'owner', 'founder'].includes(role)) return { role: 'admin', permission_tier: 'founder' }
  if (['cd', 'creative_director'].includes(role)) return { role: 'creative_director', permission_tier: 'producer' }
  if (role === 'producer') return { role: 'producer', permission_tier: 'producer' }
  if (['artist', 'freelancer'].includes(role)) return { role: 'other', permission_tier: role }
  throw new Error('Unrecognized Kit role')
}
