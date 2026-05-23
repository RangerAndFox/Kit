// @ts-nocheck
/**
 * Shared types for the shot list feature.
 * Spec: docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md
 */

export interface Shot {
  number: number       // 1-indexed
  action: string
  dialogue?: string
  duration?: string
  notes?: string
}

export interface ShotList {
  shots: Shot[]
  title?: string
}

export interface ShotMutation {
  op: 'insert' | 'update' | 'delete' | 'replace_all'
  shot_number?: number       // for update/delete
  after_shot_number?: number // for insert
  shot?: Shot                // for insert/update
  shots?: Shot[]             // for replace_all
}
