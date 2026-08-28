export type WorkbackStatus = 'Not Started' | 'In Progress' | 'Client Review' | 'Complete' | 'Blocked'

export interface WorkbackMilestone {
  task: string
  phase: string
  startDate: string
  dueDate: string
  status: WorkbackStatus
  percentComplete: number
  sortOrder: number
}

const TEMPLATES: Record<string, string[]> = {
  'Standard Sizzle': ['Script V1', 'Script V2', 'Storyboards', 'Boardomatic V1', 'Boardomatic V2', 'Animation R1', 'Animation R2', 'Delivery Preview', 'Final Delivery'],
  'Fast-Turn': ['Creative Direction', 'First Cut', 'Client Review', 'Final Polish', 'Final Delivery'],
  'Project Update': ['Plan', 'Working Draft', 'Internal Review', 'Client Review', 'Final Delivery'],
  'Internal Project': ['Brief', 'Working Draft', 'Internal Review', 'Final Delivery'],
}

function parseIso(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) throw new Error(`Invalid ISO date: ${value}`)
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`Invalid ISO date: ${value}`)
  }
  return d
}

function iso(d: Date): string { return d.toISOString().slice(0, 10) }
function isBusinessDay(d: Date): boolean { const n = d.getUTCDay(); return n !== 0 && n !== 6 }
function businessDays(start: Date, end: Date): Date[] {
  const out: Date[] = []
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (isBusinessDay(d)) out.push(new Date(d))
  }
  return out
}

export function suggestMilestoneNames(template: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 2 || count > 20) throw new Error('Milestone count must be between 2 and 20')
  if (template === 'Custom') {
    return Array.from({ length: count }, (_, i) => i === count - 1 ? 'Final Delivery' : `Milestone ${i + 1}`)
  }
  const seed = TEMPLATES[template] || TEMPLATES['Standard Sizzle']
  if (count === seed.length) return [...seed]
  if (count < seed.length) {
    const chosen = Array.from({ length: count }, (_, i) => seed[Math.round(i * (seed.length - 1) / (count - 1))])
    chosen[count - 1] = 'Final Delivery'
    return [...new Set(chosen)].slice(0, count)
  }
  const out = seed.slice(0, -1)
  while (out.length < count - 1) out.push(`Review R${out.filter((x) => x.startsWith('Review R')).length + 1}`)
  return [...out, 'Final Delivery']
}

function phaseFor(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('script') || n.includes('brief') || n.includes('plan')) return 'Pre-Production'
  if (n.includes('board') || n.includes('design') || n.includes('direction')) return 'Design'
  if (n.includes('anim') || n.includes('cut') || n.includes('draft')) return 'Animation'
  if (n.includes('review') || n.includes('preview')) return 'Review'
  if (n.includes('delivery') || n.includes('polish')) return 'Delivery/Completion'
  return 'Production'
}

export function generateWorkback(input: {
  startDate: string
  deliveryDate: string
  milestoneCount: number
  template?: string
  milestoneNames?: string[]
  today?: string
  /** Draft schedules remain inactive until the producer explicitly approves. */
  draft?: boolean
}): WorkbackMilestone[] {
  const start = parseIso(input.startDate)
  const end = parseIso(input.deliveryDate)
  if (end < start) throw new Error('Delivery date must be on or after start date')
  const days = businessDays(start, end)
  if (days.length < 2) throw new Error('Project window must contain at least two business days')
  const names = input.milestoneNames?.map((x) => x.trim()).filter(Boolean)
    || suggestMilestoneNames(input.template || 'Standard Sizzle', input.milestoneCount)
  if (names.length !== input.milestoneCount) throw new Error('Milestone names must match milestone count')
  const today = input.today ? parseIso(input.today) : new Date()
  return names.map((task, i) => {
    const startIndex = Math.floor(i * days.length / names.length)
    const dueIndex = i === names.length - 1 ? days.length - 1 : Math.max(startIndex, Math.floor((i + 1) * days.length / names.length) - 1)
    const s = days[Math.min(startIndex, days.length - 1)]
    const due = days[Math.min(dueIndex, days.length - 1)]
    const status: WorkbackStatus = input.draft ? 'Not Started' : (today > due ? 'Not Started' : today >= s ? 'In Progress' : 'Not Started')
    return { task, phase: phaseFor(task), startDate: iso(s), dueDate: iso(due), status, percentComplete: 0, sortOrder: (i + 1) * 10 }
  })
}

export function matchMilestone(fileName: string, tasks: string[]): { task: string | null; confidence: 'exact' | 'probable' | 'uncertain' } {
  const norm = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const file = norm(fileName)
  const exact = tasks.find((t) => file.includes(norm(t)))
  if (exact) return { task: exact, confidence: 'exact' }
  const scored = tasks.map((task) => {
    const words = norm(task).split(' ').filter((w) => w.length > 1)
    const hits = words.filter((w) => file.includes(w)).length
    return { task, score: words.length ? hits / words.length : 0 }
  }).sort((a, b) => b.score - a.score)[0]
  return scored?.score >= .6 ? { task: scored.task, confidence: 'probable' } : { task: null, confidence: 'uncertain' }
}
