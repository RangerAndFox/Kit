/**
 * Pilots — deterministic derived-metric owner.
 *
 * No I/O, no model involvement. This is the SINGLE authoritative source for
 * every calculated metric (invariant: derived values are recomputed here, never
 * stored authoritatively or supplied by a prompt). The canonical metric is the
 * usable-output rate.
 */

import type { GenerationRow } from './types'

export interface PilotMetrics {
  /** Total generated outputs recorded. */
  totalGenerations: number
  /** Outputs a human explicitly accepted. */
  usableGenerations: number
  /** Outputs explicitly rejected. */
  rejectedGenerations: number
  /** Outputs still awaiting a human decision. */
  pendingGenerations: number
  /**
   * usable_output_rate = usable / total. Explicitly NULL (not 0) when there are
   * zero outputs — a rate is undefined with no denominator, and reporting 0%
   * would falsely imply "we generated things and none were usable".
   */
  usableOutputRate: number | null
}

/**
 * Compute all derived metrics from the generations list. Pure and total: any
 * array (including empty) yields a well-defined result; the zero-output case
 * returns usableOutputRate = null.
 */
export function computePilotMetrics(generations: GenerationRow[]): PilotMetrics {
  const total = generations.length
  let usable = 0
  let rejected = 0
  let pending = 0
  for (const g of generations) {
    if (g.acceptance === 'accepted') usable++
    else if (g.acceptance === 'rejected') rejected++
    else pending++
  }
  return {
    totalGenerations: total,
    usableGenerations: usable,
    rejectedGenerations: rejected,
    pendingGenerations: pending,
    usableOutputRate: total === 0 ? null : usable / total,
  }
}

/** Human-readable percentage for the rate, or 'n/a' when undefined (zero outputs). */
export function formatUsableOutputRate(rate: number | null): string {
  if (rate === null) return 'n/a (no outputs recorded)'
  return `${(rate * 100).toFixed(1)}%`
}
