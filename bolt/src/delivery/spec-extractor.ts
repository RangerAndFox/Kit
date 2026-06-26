// @ts-nocheck
/**
 * Delivery spec extraction.
 *
 * Delivery specs change every event, so instead of a fixed catalog Kit asks for
 * the spec and the operator provides it as free text, a document (PDF), or a
 * screenshot. Claude (vision-capable) reads it; this module normalizes the
 * loose result into the exact DeliveryProfile shape the render pipeline needs,
 * flagging anything the source didn't specify.
 *
 * The Claude call is I/O; `normalizeExtractedSpec` + the parse helpers are pure
 * and unit-tested.
 */

import { anthropic, SPECIALIST_MODEL } from '../llm/client'
import type { AudioChannel } from '../../../src/lib/delivery/types'

export interface ExtractedSpec {
  name: string
  video_codec: string
  resolution_w: number
  resolution_h: number
  frame_rate: string
  frame_rate_mode: 'cfr' | 'vfr'
  audio_codec: string
  audio_sample_rate: number
  audio_channels: AudioChannel[]
  lufs_target: number | null
  true_peak_limit: number | null
  container: string
  notes: string | null
}

export interface NormalizedSpec {
  spec: ExtractedSpec
  /** Fields the source didn't pin down (filled with a default; confirm these). */
  missing: string[]
  warnings: string[]
}

// ── Parse helpers (pure) ───────────────────────────────────

export function parseResolution(raw: string | undefined): { w: number; h: number } | null {
  if (!raw) return null
  const s = String(raw).toLowerCase().trim()
  const wxh = s.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/)
  if (wxh) return { w: Number(wxh[1]), h: Number(wxh[2]) }
  if (/\b(4k|uhd|2160p?)\b/.test(s)) return { w: 3840, h: 2160 }
  if (/\b(1080p?|fhd|hd1080)\b/.test(s)) return { w: 1920, h: 1080 }
  if (/\b(720p?|hd720)\b/.test(s)) return { w: 1280, h: 720 }
  if (/\b(8k)\b/.test(s)) return { w: 7680, h: 4320 }
  return null
}

export function parseFrameRate(raw: string | number | undefined): string | null {
  if (raw == null) return null
  const m = String(raw).match(/(\d+(?:\.\d+)?)/)
  return m ? m[1] : null
}

export function mapVideoCodec(raw: string | undefined): string | null {
  if (!raw) return null
  const s = String(raw).toLowerCase().replace(/[._-]/g, ' ')
  if (s.includes('prores')) {
    if (s.includes('4444')) return 'prores_4444'
    if (s.includes('proxy')) return 'prores_422_proxy'
    if (s.includes('lt')) return 'prores_422_lt'
    if (s.includes('hq')) return 'prores_422_hq'
    return 'prores_422'
  }
  if (/(h\s*264|avc|x264)/.test(s)) return s.includes('broadcast') ? 'h264_broadcast' : 'h264'
  if (s.includes('dnxhr') || s.includes('dnxhd')) {
    if (s.includes('444')) return 'dnxhr_444'
    if (s.includes('hqx')) return 'dnxhr_hqx'
    if (s.includes('hq')) return 'dnxhr_hq'
    if (s.includes('sq')) return 'dnxhr_sq'
    if (s.includes('lb')) return 'dnxhr_lb'
    return 'dnxhr_hq'
  }
  return null
}

export function mapAudioCodec(raw: string | undefined): string | null {
  if (!raw) return null
  const s = String(raw).toLowerCase()
  if (s.includes('aac')) return 'aac'
  if (s.includes('pcm') || s.includes('wav') || s.includes('uncompressed')) {
    return s.includes('16') ? 'pcm_s16le' : 'pcm_s24le'
  }
  if (s.includes('24')) return 'pcm_s24le'
  if (s.includes('16')) return 'pcm_s16le'
  return null
}

const STEREO: AudioChannel[] = [
  { channel: 1, label: 'Left', source: 'L' },
  { channel: 2, label: 'Right', source: 'R' },
]
const MONO: AudioChannel[] = [{ channel: 1, label: 'Mono', source: 'L' }]
const SURROUND_51: AudioChannel[] = [
  { channel: 1, label: 'FL', source: 'FL' },
  { channel: 2, label: 'FR', source: 'FR' },
  { channel: 3, label: 'FC', source: 'FC' },
  { channel: 4, label: 'LFE', source: 'LFE' },
  { channel: 5, label: 'SL', source: 'SL' },
  { channel: 6, label: 'SR', source: 'SR' },
]

export function parseChannels(raw: string | number | undefined): AudioChannel[] | null {
  if (raw == null) return null
  const s = String(raw).toLowerCase()
  if (s.includes('5.1') || s.includes('5,1')) return SURROUND_51
  if (s.includes('mono')) return MONO
  if (s.includes('stereo')) return STEREO
  const n = Number(String(raw).match(/\d+/)?.[0])
  if (n === 1) return MONO
  if (n === 2) return STEREO
  if (n === 6) return SURROUND_51
  if (Number.isFinite(n) && n > 0) {
    return Array.from({ length: n }, (_, i) => ({ channel: i + 1, label: `Ch ${i + 1}`, source: i === 0 ? 'L' : i === 1 ? 'R' : 'silent' }))
  }
  return null
}

export function parseNumber(raw: string | number | undefined): number | null {
  if (raw == null) return null
  const m = String(raw).match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/**
 * Coerce a loose, human-shaped spec (from the LLM) into the exact
 * DeliveryProfile fields, defaulting + flagging anything unspecified.
 */
export function normalizeExtractedSpec(raw: any): NormalizedSpec {
  const missing: string[] = []
  const warnings: string[] = []

  const res = parseResolution(raw?.resolution) || parseResolution(`${raw?.resolution_w}x${raw?.resolution_h}`)
  if (!res) missing.push('resolution')

  const fps = parseFrameRate(raw?.frame_rate)
  if (!fps) missing.push('frame_rate')

  const vcodec = mapVideoCodec(raw?.video_codec)
  if (!vcodec) missing.push('video_codec')

  const acodec = mapAudioCodec(raw?.audio_codec)
  const channels = parseChannels(raw?.audio_channels)
  const sampleRate = parseNumber(raw?.audio_sample_rate)

  const spec: ExtractedSpec = {
    name: (raw?.name && String(raw.name).trim()) || 'Event delivery spec',
    video_codec: vcodec || 'prores_422_hq',
    resolution_w: res?.w ?? 1920,
    resolution_h: res?.h ?? 1080,
    frame_rate: fps || '29.97',
    frame_rate_mode: /vfr|variable/i.test(String(raw?.frame_rate_mode || '')) ? 'vfr' : 'cfr',
    audio_codec: acodec || 'pcm_s24le',
    audio_sample_rate: sampleRate || 48000,
    audio_channels: channels || STEREO,
    lufs_target: parseNumber(raw?.lufs_target),
    true_peak_limit: parseNumber(raw?.true_peak_limit),
    container: (raw?.container && String(raw.container).toLowerCase().replace(/[^a-z0-9]/g, '')) || 'mov',
    notes: (raw?.notes && String(raw.notes).trim()) || null,
  }

  if (!acodec) warnings.push('audio codec not stated — defaulted to PCM 24-bit')
  if (!channels) warnings.push('channel layout not stated — defaulted to stereo')
  if (spec.lufs_target == null) warnings.push('no loudness target stated — skipping normalization')

  return { spec, missing, warnings }
}

// ── Claude extraction (I/O) ────────────────────────────────

const EXTRACTION_SYSTEM = `You read broadcast/event video delivery specifications and return them as JSON.
Extract these fields (use null when the source doesn't state one — never invent values):
{
  "name": string,              // short label, e.g. "Microsoft Ignite 2026 — Session"
  "video_codec": string,       // as written, e.g. "ProRes 422 HQ", "H.264"
  "resolution": string,        // e.g. "1920x1080", "1080p", "4K"
  "frame_rate": string,        // e.g. "29.97"
  "frame_rate_mode": string,   // "cfr" or "vfr" if stated
  "audio_codec": string,       // e.g. "PCM 24-bit", "AAC"
  "audio_channels": string,    // e.g. "stereo", "5.1", "mono", or a number
  "audio_sample_rate": number, // e.g. 48000
  "lufs_target": number,       // integrated loudness, e.g. -24
  "true_peak_limit": number,   // dBTP, e.g. -2
  "container": string,         // e.g. "mov", "mp4"
  "notes": string              // anything else relevant (head/tail slate, naming, etc.)
}
Return ONLY the JSON object, no prose, no code fences.`

/**
 * Ask Claude to extract a spec from text and/or an attached image/PDF.
 * Returns the loose JSON; pass it through normalizeExtractedSpec().
 */
export async function extractSpec(input: {
  text?: string
  image?: { base64: string; mediaType: string }
  pdf?: { base64: string }
}): Promise<any> {
  const content: any[] = []
  if (input.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.image.mediaType, data: input.image.base64 } })
  }
  if (input.pdf) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdf.base64 } })
  }
  content.push({
    type: 'text',
    text: input.text
      ? `Delivery spec (text):\n\n${input.text}`
      : 'Extract the delivery spec from the attached file.',
  })

  const res = await anthropic.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content }],
  })
  const text =
    res.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error(`Spec extraction returned non-JSON: ${text.slice(0, 200)}`)
  }
}

/** Convenience: extract + normalize in one call. */
export async function extractAndNormalize(input: {
  text?: string
  image?: { base64: string; mediaType: string }
  pdf?: { base64: string }
}): Promise<NormalizedSpec> {
  return normalizeExtractedSpec(await extractSpec(input))
}
