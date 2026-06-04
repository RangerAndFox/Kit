import type { ProvisioningResults, ServiceKey, ServiceResult } from './types'

/**
 * Builds Block Kit blocks summarizing provisioning results.
 */
export function buildSummaryBlocks(results: ProvisioningResults, projectName: string): any[] {
  const services: Array<{ label: string; key: ServiceKey; r: ServiceResult | undefined }> = [
    { label: 'Dropbox', key: 'dropbox', r: results.dropbox },
    { label: 'Frame.io', key: 'frameio', r: results.frameio },
    { label: 'Canva', key: 'canva', r: results.canva },
    { label: 'FigJam', key: 'figma', r: results.figma },
    { label: 'Slack Channel', key: 'slack', r: results.slack },
  ]

  const ran = services.filter((s) => s.r && s.r.error !== 'skipped')
  const succeeded = ran.filter((s) => s.r?.success)
  const failed = ran.filter((s) => s.r && !s.r.success)

  const badge =
    failed.length === 0
      ? `All ${succeeded.length} services provisioned`
      : `${succeeded.length}/${ran.length} services provisioned`

  const lines = services.map(({ label, r }) => {
    if (!r || r.error === 'skipped') return `_${label}: skipped_`
    if (r.success && r.url) return `*${label}:* <${r.url}|Open>`
    if (r.success) return `*${label}:* done`
    return `*${label}:* failed — ${r.error}`
  })

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${projectName} — Project Provisioned` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: badge },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
  ]

  return blocks
}
