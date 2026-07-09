/**
 * Render a unicode progress bar for the delivery job's Slack message.
 * e.g. progressBar(45) → "▓▓▓▓▓▓▓▓▓░░░░░░░░░░░ 45%"
 */
export function progressBar(percent: number, width = 20): string {
  const p = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)))
  const filled = Math.round((p / 100) * width)
  return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)} ${p}%`
}
