/**
 * Frame-split planner for the After Effects render farm.
 *
 * Splits a composition's frame range into N contiguous chunks so each studio
 * machine renders a slice in parallel. Frames are 0-based and inclusive:
 * a 300-frame comp is frames 0..299.
 *
 * Spec: AE-RENDER-FARM-SPEC.md, "Frame-split planner".
 */

export interface FrameChunk {
  index: number
  frameStart: number  // inclusive
  frameEnd: number    // inclusive
  frameCount: number
}

/**
 * Split [startFrame .. startFrame+totalFrames-1] into `chunkCount` contiguous
 * ranges that differ in size by at most one frame. The first `remainder` chunks
 * get one extra frame so every frame is covered with no gaps or overlaps.
 */
export function planChunks(totalFrames: number, chunkCount: number, startFrame = 0): FrameChunk[] {
  if (totalFrames <= 0) throw new Error('planChunks: totalFrames must be > 0')
  const count = Math.max(1, Math.min(Math.floor(chunkCount) || 1, totalFrames))

  const base = Math.floor(totalFrames / count)
  const remainder = totalFrames % count

  const chunks: FrameChunk[] = []
  let cursor = startFrame
  for (let i = 0; i < count; i++) {
    const size = base + (i < remainder ? 1 : 0)
    const frameStart = cursor
    const frameEnd = cursor + size - 1
    chunks.push({ index: i, frameStart, frameEnd, frameCount: size })
    cursor = frameEnd + 1
  }
  return chunks
}

/**
 * Pick how many chunks to cut a comp into given the pool of online AE-capable
 * workers. More chunks improve load-balancing and failover granularity, but each
 * chunk pays AE's launch cost (~10-30s), so we keep chunks at least
 * `minFramesPerChunk` long and never exceed `maxChunksPerWorker` per worker.
 */
export function chooseChunkCount(
  totalFrames: number,
  workerCount: number,
  opts: { minFramesPerChunk?: number; maxChunksPerWorker?: number } = {},
): number {
  const minFramesPerChunk = opts.minFramesPerChunk ?? 24
  const maxChunksPerWorker = opts.maxChunksPerWorker ?? 2
  const workers = Math.max(1, workerCount)

  const maxByMinSize = Math.max(1, Math.floor(totalFrames / minFramesPerChunk))
  const desired = workers * maxChunksPerWorker
  return Math.max(1, Math.min(desired, maxByMinSize, totalFrames))
}
