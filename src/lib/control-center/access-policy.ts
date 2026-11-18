export function canViewControlCenter(member: { role: string; permission_tier: string | null; is_active: boolean | null } | null): boolean {
  return !!member && member.is_active !== false && ['founder', 'admin'].includes(member.permission_tier || member.role)
}
