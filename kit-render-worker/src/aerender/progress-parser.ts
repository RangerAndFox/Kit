// @ts-nocheck
/**
 * Parse aerender stdout into a per-chunk progress percentage.
 *
 * aerender emits one PROGRESS line per rendered frame, e.g.:
 *   PROGRESS:  0:00:00:00 (1): 0 Seconds
 *   PROGRESS:  0:00:00:01 (2): 1 Second
 *   ...
 *   PROGRESS:  Finished composition "Comp 1".
 *
 * The number in parentheses is the absolute comp frame currently being written.
 * For a chunk rendering frames [frameStart..frameEnd], percent is the position
 * of the current frame within that range.
 */

export interface AeProgressUpdate {
  current_frame: number
  percent: number          // 0..100 within this chunk's range
  finished: boolean
}

const FRAME_RE = /PROGRESS:\s+[\d:]+\s+\((\d+)\)/i
const FINISHED_RE = /PROGRESS:\s+Finished\s+composition/i

export function parseAerenderProgress(
  line: string,
  frameStart: number,
  frameEnd: number,
): AeProgressUpdate | null {
  if (FINISHED_RE.test(line)) {
    return { current_frame: frameEnd, percent: 100, finished: true }
  }

  const m = line.match(FRAME_RE)
  if (!m) return null

  const current = Number(m[1])
  const span = Math.max(1, frameEnd - frameStart + 1)
  const done = Math.min(span, Math.max(0, current - frameStart + 1))
  const percent = Math.round((done / span) * 100)

  return {
    current_frame: current,
    percent: Math.min(100, Math.max(0, percent)),
    finished: false,
  }
}
