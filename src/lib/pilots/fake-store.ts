/**
 * In-memory PilotStorePort + PilotCanvasPort fakes for unit / controlled-workflow
 * tests. Not used in production — the real ports live in store.ts / canvas.ts.
 * Deterministic ids (a counter) so tests never depend on Math.random / Date.now.
 */

import type { PilotCanvasPort, PilotStorePort } from './service'
import type {
  EvidenceRow,
  GenerationRow,
  MaterialMapRow,
  PilotRow,
  PilotSnapshot,
  ReferenceRow,
  ValidationRow,
} from './types'

export interface FakeProjectInfo {
  status: string | null
  workspace_id: string | null
  slack_channel_id: string | null
}

export interface FakePilotStore extends PilotStorePort {
  /** Seeded project → workspace map (authoritative source for create auth). */
  projectWorkspaces: Record<string, string>
  /** Seeded richer project facts for the readiness diagnostic. */
  projectInfos: Record<string, FakeProjectInfo>
  /** When false, pilotSchemaPresent() reports the schema as unavailable. */
  schemaPresent: boolean
  pilots: PilotRow[]
  references: ReferenceRow[]
  evidence: EvidenceRow[]
  generations: GenerationRow[]
  materialMaps: MaterialMapRow[]
  validations: ValidationRow[]
}

export function makeFakePilotStore(): FakePilotStore {
  let seq = 0
  const id = (prefix: string) => `${prefix}_${++seq}`
  const T = '2026-01-01T00:00:00.000Z'

  const projectWorkspaces: Record<string, string> = {}
  const projectInfos: Record<string, FakeProjectInfo> = {}
  const state = { schemaPresent: true }
  const pilots: PilotRow[] = []
  const references: ReferenceRow[] = []
  const evidence: EvidenceRow[] = []
  const generations: GenerationRow[] = []
  const materialMaps: MaterialMapRow[] = []
  const validations: ValidationRow[] = []

  return {
    projectWorkspaces,
    projectInfos,
    get schemaPresent() {
      return state.schemaPresent
    },
    set schemaPresent(v: boolean) {
      state.schemaPresent = v
    },
    pilots,
    references,
    evidence,
    generations,
    materialMaps,
    validations,

    async getProjectWorkspaceId(projectId) {
      return projectWorkspaces[projectId] ?? null
    },
    async getProjectInfo(projectId) {
      const info = projectInfos[projectId]
      if (info) return { exists: true, ...info }
      // Fall back to the workspace-only seed so create-auth tests keep working.
      const ws = projectWorkspaces[projectId]
      if (ws) return { exists: true, status: 'active', workspace_id: ws, slack_channel_id: null }
      return { exists: false, status: null, workspace_id: null, slack_channel_id: null }
    },
    async pilotSchemaPresent() {
      return state.schemaPresent
    },
    async countActivePilots() {
      return pilots.filter((p) => p.status === 'active').length
    },
    async getPilotById(pid) {
      return pilots.find((p) => p.id === pid) ?? null
    },
    async getActivePilot(projectId, pilotType) {
      return (
        pilots.find((p) => p.project_id === projectId && p.pilot_type === pilotType && p.status === 'active') ?? null
      )
    },
    async insertPilot(v) {
      const row: PilotRow = {
        id: id('pilot'),
        project_id: v.project_id,
        workspace_id: v.workspace_id,
        pilot_type: v.pilot_type as PilotRow['pilot_type'],
        title: v.title,
        status: 'active',
        visual_language: null,
        recommendation: null,
        recommendation_rationale: null,
        recommendation_by: null,
        recommendation_at: null,
        canvas_id: null,
        canvas_url: null,
        created_by: v.created_by,
        created_at: T,
        updated_at: T,
      }
      pilots.push(row)
      return row
    },
    async updatePilot(pid, patch) {
      const p = pilots.find((x) => x.id === pid)
      if (!p) throw new Error('updatePilot: not found')
      Object.assign(p, patch, { updated_at: T })
    },
    async insertReference(v) {
      const row: ReferenceRow = { id: id('ref'), created_at: T, ...v }
      references.push(row)
      return row
    },
    async insertEvidence(v) {
      const row: EvidenceRow = { id: id('ev'), created_at: T, ...v }
      evidence.push(row)
      return row
    },
    async insertGeneration(v) {
      const row: GenerationRow = {
        id: id('gen'),
        created_at: T,
        acceptance: 'pending',
        accepted_by: null,
        accepted_at: null,
        ...v,
      }
      generations.push(row)
      return row
    },
    async getGenerationById(gid) {
      return generations.find((g) => g.id === gid) ?? null
    },
    async setGenerationAcceptance(gid, patch) {
      const g = generations.find((x) => x.id === gid)
      if (!g) throw new Error('setGenerationAcceptance: not found')
      g.acceptance = patch.acceptance
      g.accepted_by = patch.accepted_by
      g.accepted_at = patch.accepted_at
    },
    async insertMaterialMap(v) {
      const row: MaterialMapRow = { id: id('map'), created_at: T, ...v }
      materialMaps.push(row)
      return row
    },
    async insertValidation(v) {
      const row: ValidationRow = { id: id('val'), created_at: T, ...v }
      validations.push(row)
      return row
    },
    async loadSnapshot(pilotId): Promise<PilotSnapshot | null> {
      const pilot = pilots.find((p) => p.id === pilotId)
      if (!pilot) return null
      return {
        pilot,
        references: references.filter((r) => r.pilot_id === pilotId),
        evidence: evidence.filter((e) => e.pilot_id === pilotId),
        generations: generations.filter((g) => g.pilot_id === pilotId),
        materialMaps: materialMaps.filter((m) => m.pilot_id === pilotId),
        validations: validations.filter((v) => v.pilot_id === pilotId),
      }
    },
  }
}

export interface FakeCanvas extends PilotCanvasPort {
  created: number
  edited: number
  lastMarkdown: string | null
}

export function makeFakeCanvas(): FakeCanvas {
  const state = { created: 0, edited: 0, lastMarkdown: null as string | null }
  return {
    get created() {
      return state.created
    },
    get edited() {
      return state.edited
    },
    get lastMarkdown() {
      return state.lastMarkdown
    },
    async createPilotCanvas(o) {
      state.created++
      state.lastMarkdown = o.markdown
      return { canvasId: 'canvas_1', canvasUrl: 'https://slack/canvas_1' }
    },
    async editPilotCanvas(o) {
      state.edited++
      state.lastMarkdown = o.markdown
    },
  }
}
