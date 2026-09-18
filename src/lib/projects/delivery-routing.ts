/** Exact identities only: folder labels are mutable, project numbers are not. */
export function deliveryProjectNumber(value: string): string | null {
  return value.trim().match(/^(\d+[A-Za-z]?)(?=[^A-Za-z0-9]|$)/)?.[1].toUpperCase() || null
}

type Candidate = {
  id: string
  project_code?: string | null
  external_ids?: Record<string, unknown> | null
}

export function selectDeliveryProject<T extends Candidate>(rows: T[], safeName: string): T {
  const number = deliveryProjectNumber(safeName)
  if (!number) throw new Error('Delivery folder has no valid project number')
  const matches = rows.filter(row => !row.external_ids?.merged_into_project_id && (
    String(row.external_ids?.project_number || '').toUpperCase() === number ||
    deliveryProjectNumber(row.project_code || '') === number
  ))
  if (matches.length !== 1) {
    throw new Error(`Delivery project ${number}: ${matches.length ? 'ambiguous existing records; reconcile identities' : 'not provisioned; provision or link the project first'}`)
  }
  return matches[0]
}

type Producer = { full_name: string | null; slack_user_id: string | null; role: string | null; is_active: boolean }

/** Studio-approved naming alias, never fuzzy/substring matching. */
const normalizeProducer = (value: string) => {
  const name = value.trim().toLowerCase().replace(/\s+/g, ' ')
  return name === 'ally' ? 'allyson' : name
}

export function selectDeliveryProducer(label: string, staff: Producer[]): string {
  const normalized = normalizeProducer(label)
  const eligible = staff.filter(person => person.is_active && ['admin', 'producer'].includes(person.role || '') && person.slack_user_id)
  const exact = eligible.filter(person => normalizeProducer(person.full_name || '') === normalized || person.slack_user_id === label.trim())
  const matches = exact.length ? exact : eligible.filter(person => normalizeProducer(person.full_name || '').split(' ')[0] === normalized)
  if (!normalized || matches.length !== 1) throw new Error('Delivery producer is missing, ambiguous, or not an active producer/admin')
  return matches[0].slack_user_id!
}
