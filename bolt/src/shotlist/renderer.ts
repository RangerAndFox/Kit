// @ts-nocheck
/**
 * Render a Shot[] into Slack canvas markdown.
 *
 * Slack canvases support GitHub-flavored markdown with simple tables
 * and inline images via `![](permalink)`.
 */

import type { Shot } from './types'

export function renderShotsToMarkdown(
  shots: Shot[],
  thumbnails: Record<number, string[]> = {},
  title?: string,
): string {
  const lines: string[] = []
  if (title) {
    lines.push(`# ${title}`, '')
  } else {
    lines.push('# Shot List', '')
  }

  if (shots.length === 0) {
    lines.push('_No shots yet. @mention Kit with a script to populate._')
    return lines.join('\n')
  }

  // Header row
  lines.push('| # | Visual | Sound / Dialogue | Duration | Reference |')
  lines.push('|---|---|---|---|---|')

  for (const s of shots) {
    const refs = thumbnails[s.number] || []
    const refCell = refs.length > 0
      ? refs.map((url) => `![](${url})`).join(' ')
      : '_drop image to add_'
    const visual = s.notes ? `${s.action}<br/>_${s.notes}_` : s.action
    const sound = s.dialogue || ''
    const duration = s.duration || ''
    lines.push(`| ${s.number} | ${visual} | ${sound} | ${duration} | ${refCell} |`)
  }

  lines.push('', `_${shots.length} shot${shots.length === 1 ? '' : 's'}. Last updated ${new Date().toISOString()}._`)
  return lines.join('\n')
}
