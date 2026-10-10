/** Exact studio-number identity, never substring matching (2645 != 26450). */
export function studioProjectNumber(value: string | null | undefined): string | null {
  return value?.trim().match(/^(\d{3,4}[a-z]?)(?=$|[-_\s])/i)?.[1].toUpperCase() || null
}

export function projectCodeMatches(stored: string | null, requested: string): boolean {
  if (stored?.toLowerCase() === requested.trim().toLowerCase()) return true
  // Only a bare number is allowed to expand to a canonical code.
  return /^\d{3,4}[a-z]?$/i.test(requested.trim()) && studioProjectNumber(stored) === requested.trim().toUpperCase()
}
