/** Human-facing Harvest project links (separate from API URLs). */
const DEFAULT_HARVEST_WEB_BASE_URL = 'https://rangerfox.harvestapp.com'

export function harvestWebBaseUrl(): string {
  const configured = String(process.env.HARVEST_WEB_BASE_URL || '').trim()
  if (!configured) return DEFAULT_HARVEST_WEB_BASE_URL
  try {
    const url = new URL(configured)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.harvestapp.com')) {
      return DEFAULT_HARVEST_WEB_BASE_URL
    }
    return url.origin
  } catch {
    return DEFAULT_HARVEST_WEB_BASE_URL
  }
}

export function harvestProjectWebUrl(projectId: number | string): string {
  const id = String(projectId).trim()
  if (!/^\d+$/.test(id)) throw new Error('Harvest project id must be numeric')
  return `${harvestWebBaseUrl()}/projects/${id}`
}
