/**
 * Channel mapping — translate audio_channels JSON into FFmpeg -af filter syntax.
 *
 * Spec: DELIVERY-PIPELINE-SPEC.md, "Channel Mapping Examples".
 *
 * Copied from src/lib/delivery/channel-mapper.ts — standalone duplicate
 * intentional so kit-render-worker ships self-contained.
 */

import type { AudioChannel } from '../types'

// Maps audio_channels source label → FFmpeg input channel reference.
// For "L"/"R" we assume stereo source on input 0.
// For "FL".."SR" we assume 5.1 source on input 0.
// Other sources ("file:..." or "silent") require special handling at the
// worker level — the worker builds an amerge chain.
const STEREO_CHANNEL_REF: Record<string, string> = {
  L: 'c0',
  R: 'c1',
}

const SURROUND_5_1_CHANNEL_REF: Record<string, string> = {
  FL: 'c0',
  FR: 'c1',
  FC: 'c2',
  LFE: 'c3',
  SL: 'c4',
  SR: 'c5',
}

function resolveSource(src: string): string | null {
  if (src in STEREO_CHANNEL_REF) return STEREO_CHANNEL_REF[src]
  if (src in SURROUND_5_1_CHANNEL_REF) return SURROUND_5_1_CHANNEL_REF[src]
  if (src === 'silent') return '0*c0' // silent — scale c0 by 0
  // file: refs and other forms are handled by the worker via amerge; this
  // module doesn't try to emit them inside `pan=`.
  return null
}

/**
 * Build a `pan=` filter expression from an audio_channels array.
 *
 * Throws if a channel references an external file (`file:...`) — those require
 * an amerge chain that the caller must build separately. Callers should
 * pre-check with `requiresAmerge()` and skip this function in that case.
 *
 * Returns the pan filter string for all supported source types
 * (L/R/FL/FR/FC/LFE/SL/SR/silent).
 */
export function buildChannelMapFilter(channels: AudioChannel[]): string | null {
  if (!channels || channels.length === 0) return null

  // Detect 5.1 sources to choose the right output layout descriptor.
  const usesSurround = channels.some((c) =>
    Object.keys(SURROUND_5_1_CHANNEL_REF).includes(String(c.source)),
  )

  // Choose output layout based on channel count + sources.
  let layout: string
  switch (channels.length) {
    case 1:
      layout = 'mono'
      break
    case 2:
      layout = 'stereo'
      break
    case 4:
      layout = '4.0'
      break
    case 6:
      layout = '5.1'
      break
    default:
      layout = String(channels.length) + 'c'
  }
  if (usesSurround && channels.length === 6) layout = '5.1'

  // Build c0=..., c1=..., ... segments.
  const segments: string[] = []
  channels.forEach((ch, idx) => {
    const ref = resolveSource(String(ch.source))
    if (ref == null) {
      // Unsupported source (e.g. file:mix.wav:L) — worker must handle externally.
      // Returning null signals the caller to skip the pan filter and build
      // an amerge chain instead.
      throw new Error(
        `Channel ${ch.channel} uses unsupported source "${ch.source}" — worker must build an amerge chain for external files.`,
      )
    }
    segments.push(`c${idx}=${ref}`)
  })

  return `pan=${layout}|${segments.join('|')}`
}

/**
 * Returns true if any of the channels references an external file or other
 * complex source. The caller should defer to worker-side amerge construction
 * (and skip buildChannelMapFilter).
 */
export function requiresAmerge(channels: AudioChannel[]): boolean {
  return channels.some((c) => /^file:/i.test(String(c.source)))
}
