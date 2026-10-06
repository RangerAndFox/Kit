/** Private health detail: bounded, actionable, and never raw provider bodies/URLs. */
export interface DeliveryQueueIssue {
  event_type: string
  last_error: string | null
  payload: unknown
}

function clean(value: string, length: number): string {
  return value.replace(/[<>&`*_~\r\n\t]/g, ' ').replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\s+/g, ' ').trim().slice(0, length)
}

export function deliveryQueueDetail(rows: DeliveryQueueIssue[], count: number): string {
  if (!rows.length && count === 0) return 'no dead-lettered events'
  const examples = rows.slice(0, 3).map(row => {
    const p = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown> : {}
    const project = typeof p.safeName === 'string' ? p.safeName.match(/^(\d+[A-Za-z]?)(?:[_-]|$)/)?.[1] : null
    const name = typeof p.name === 'string' ? p.name.split('/').pop()! : row.event_type
    const error = row.last_error || ''
    const reason = /path\/not_found|Dropbox source missing/.test(error) ? 'source missing'
      : /404/.test(error) ? 'Frame.io status unavailable'
        : /integrity|size|media type/i.test(error) ? 'integrity check failed'
          : 'upload needs review'
    return `${project || 'Unknown project'}: ${clean(name, 32)} — ${reason}`
  })
  return `${count} upload attempt${count === 1 ? '' : 's'} need review${count > examples.length ? ` (showing ${examples.length})` : ''}: ${examples.join('; ')}`
}
