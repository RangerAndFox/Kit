export type WorldState = 'working' | 'waiting' | 'blocked' | 'idle' | 'unknown' | 'unconnected'
export type DistrictId = 'hq' | 'production' | 'delivery' | 'people' | 'finance' | 'knowledge' | 'archive' | 'marketing' | 'engineering'
export interface WorldDefinition {
  id: string
  name: string
  role: string
  district: DistrictId
  kind: 'specialist' | 'workflow' | 'orchestrator' | 'external'
  description: string
  sources: string[]
  color: string
}
export interface WorldTask {
  id: string
  agentId: string
  title: string
  state: WorldState
  recordedStatus: string
  detail: string
  at: string | null
  href: string | null
  project: string | null
  source: string
}
export interface WorldSource {
  id: string
  available: boolean
  checkedAt: string
  truncated: boolean
}
export interface WorldAgent extends WorldDefinition {
  state: WorldState
  observedAt: string | null
  detail: string
  tasks: WorldTask[]
  sessionHref: string | null
}
export interface WorldSnapshot {
  version: 1
  workspaceName: string
  observedAt: string
  refreshMs: number
  readOnly: true
  agents: WorldAgent[]
  events: WorldTask[]
  sources: WorldSource[]
}
export interface WorldAnswer {
  text: string
  evidence: Array<{ label: string; href: string }>
  observedAt: string
}
