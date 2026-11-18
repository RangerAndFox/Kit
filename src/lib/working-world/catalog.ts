import type { WorldDefinition } from './types'

/** A catalog of observed roles, not a claim that every role is a separate process.
 * Dormant managed-agent definitions are deliberately not registered as live. */
export const WORLD_AGENTS: readonly WorldDefinition[] = [
  { id: 'kit', name: 'Kit', role: 'Recorded agent runs', district: 'hq', kind: 'orchestrator', description: 'Recorded Kit agent runs. Conversational Slack turns do not yet expose session telemetry.', sources: ['runs', 'run-history'], color: '#77ba82' },
  { id: 'production', name: 'Production', role: 'Project control', district: 'production', kind: 'workflow', description: 'Project creation, updates and storyboard work.', sources: ['creation', 'updates', 'storyboards'], color: '#ae9dcd' },
  { id: 'delivery', name: 'Delivery', role: 'Dropbox → Frame', district: 'delivery', kind: 'workflow', description: 'Exact-source approvals and upload receipts. Waiting for approval is not an outage.', sources: ['uploads', 'upload-history'], color: '#83b8ca' },
  { id: 'people', name: 'People ops', role: 'Project access', district: 'people', kind: 'workflow', description: 'Durable project-access requests. Not every onboarding service step is instrumented.', sources: ['people'], color: '#dc9579' },
  { id: 'finance', name: 'Timekeeper', role: 'Hours confirmations', district: 'finance', kind: 'specialist', description: 'Workspace members’ outstanding hours cards. Harvest success requires a receipt.', sources: ['hours'], color: '#dab56a' },
  { id: 'knowledge', name: 'Knowledge', role: 'Studio knowledge', district: 'knowledge', kind: 'specialist', description: 'Knowledge-related recorded agent runs; no inference of activity from a quiet feed.', sources: ['runs', 'run-history'], color: '#a5bd91' },
  { id: 'archive', name: 'Publisher', role: 'Archive & voice jobs', district: 'archive', kind: 'workflow', description: 'Archive, Behance and ElevenLabs jobs. Their source messages link to the actual work.', sources: ['archives', 'behance', 'voice'], color: '#ca927a' },
  { id: 'marketing', name: 'Coordinator', role: 'Marketing · not connected', district: 'marketing', kind: 'external', description: 'Reserved for the organizational coordinator’s activity feed. A scheduled reminder is not proof of a live agent session.', sources: [], color: '#cfbc73' },
  { id: 'engineering', name: 'Builder', role: 'Coding agents · not connected', district: 'engineering', kind: 'external', description: 'Reserved for authorized Codex and other coding-agent feeds. Session URLs must come from the source system.', sources: [], color: '#95a9c6' },
]

export const WORLD_REFRESH_MS = 10_000
export const WORLD_STALE_MS = 45_000
export const WORLD_STATE_LABELS = { working: 'Working', waiting: 'Needs approval / queued', blocked: 'Blocked', idle: 'No active work recorded', unknown: 'Signal unknown', unconnected: 'Not connected' } as const
