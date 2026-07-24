/**
 * Real-port wiring for the Pilots service.
 *
 * Kept separate from service.ts so the orchestration/guards stay free of I/O
 * imports (Supabase / Slack) and remain unit-testable without those deps
 * installed. Only production entry points (the Bolt handler) import this.
 */

import type { PilotDeps } from './service'
import {
  getActivePilot,
  getGenerationById,
  getPilotById,
  getProjectWorkspaceId,
  insertEvidence,
  insertGeneration,
  insertMaterialMap,
  insertPilot,
  insertReference,
  insertValidation,
  loadSnapshot,
  setGenerationAcceptance,
  updatePilot,
} from './store'
import { createPilotCanvas, editPilotCanvas } from './canvas'

export function defaultPilotDeps(): PilotDeps {
  return {
    store: {
      getProjectWorkspaceId,
      getPilotById,
      getActivePilot,
      insertPilot,
      updatePilot,
      insertReference,
      insertEvidence,
      insertGeneration,
      getGenerationById,
      setGenerationAcceptance,
      insertMaterialMap,
      insertValidation,
      loadSnapshot,
    },
    canvas: { createPilotCanvas, editPilotCanvas },
    now: () => new Date().toISOString(),
  }
}
