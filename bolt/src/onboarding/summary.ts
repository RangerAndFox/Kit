import type { ServiceResult } from './types'

/**
 * Build a summary message for the requester after one onboarding run.
 */
export function buildRequesterSummary(opts: {
  artistName: string
  artistEmail: string
  projectName: string
  results: Record<string, ServiceResult>
}): string {
  const { artistName, artistEmail, projectName, results } = opts
  const icon = (s: string) =>
    s === 'ok' ? ':white_check_mark:' : s === 'skipped' ? ':white_circle:' : ':x:'
  const order: [string, string][] = [
    ['people', 'Daily Assignments'],
    ['slack', 'Slack'],
    ['dropbox', 'Dropbox'],
    ['frameio', 'Frame.io'],
    ['harvest', 'Harvest'],
    ['welcomeDm', 'Welcome DM'],
    ['nda', 'NDA'],
  ]
  const lines = order
    .filter(([key]) => results[key])
    .map(([key, label]) => {
      const r = results[key]
      const handoff = r.actionUrl ? `\n  Action needed: ${r.actionLabel || 'Follow up'} — ${r.actionUrl}` : ''
      return `${icon(r.status)} *${label}* — ${r.message}${handoff}`
    })
  return [`*Onboarding: ${artistName}* (${artistEmail}) → *${projectName}*`, '', ...lines].join(
    '\n',
  )
}
