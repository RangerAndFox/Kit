/**
 * Shared Harvest fetch helper for the one-off backfill scripts.
 * (Was duplicated verbatim in backfill-projects-from-harvest.ts and
 * backfill-clients-from-harvest.ts.)
 */

export async function harvestRequest(path: string): Promise<any> {
  const token = process.env.HARVEST_ACCESS_TOKEN
  const accountId = process.env.HARVEST_ACCOUNT_ID
  if (!token || !accountId) throw new Error('HARVEST_ACCESS_TOKEN + HARVEST_ACCOUNT_ID required')
  const res = await fetch(`https://api.harvestapp.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Harvest-Account-Id': accountId,
      'User-Agent': 'Kit Backfill (kit@rangerandfox.tv)',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Harvest ${path} ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return res.json()
}
