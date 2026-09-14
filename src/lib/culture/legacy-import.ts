import { memeSchema, type Meme } from './model'

export class LegacyImportReviewError extends Error {
  readonly code = 'legacy_import_review'
  constructor(readonly issues: string[]) {
    super('Legacy import needs review. ' + issues.slice(0, 20).join('; ') + (issues.length > 20 ? '; additional records also need review.' : '.') + ' Nothing was imported and the existing scheduler is unchanged.')
  }
}

/** Check every row before the atomic scheduler handover. Never silently skip a
 * birthday or schedule: report all offending rows without echoing private copy. */
export function validateLegacySeeds(seeds: Array<Meme & { legacy_key: string }>): void {
  const issues: string[] = []
  for (const [index, seed] of seeds.entries()) {
    const { legacy_key: _key, ...item } = seed
    void _key
    const result = memeSchema.safeParse(item)
    if (!result.success) {
      const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.') || 'public-safe wording or schedule'))]
      issues.push(`Import row ${index + 1} (${seed.kind}): check ${fields.join(', ')}`)
    }
  }
  if (issues.length) throw new LegacyImportReviewError(issues)
}
