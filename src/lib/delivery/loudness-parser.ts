/**
 * Parse FFmpeg's loudnorm pass-1 JSON output into a LoudnessMeasurement.
 *
 * FFmpeg emits the JSON block as the last lines of stderr. We scan for the
 * `{ ... }` block and JSON.parse it. All measured values arrive as strings;
 * we coerce them to numbers.
 *
 * Spec: DELIVERY-PIPELINE-SPEC.md, "Two-Pass Loudness Normalization".
 */

import type { LoudnessMeasurement } from './types'

interface RawLoudnessJson {
  input_i?: string
  input_tp?: string
  input_lra?: string
  input_thresh?: string
  output_i?: string
  output_tp?: string
  output_lra?: string
  output_thresh?: string
  normalization_type?: string
  target_offset?: string
}

/**
 * Find and parse the loudnorm JSON block in FFmpeg stderr.
 * Throws if no block is found or if required fields are missing.
 */
export function parseLoudnessJson(stderrOutput: string): LoudnessMeasurement {
  // FFmpeg's JSON block starts at the first `{` after "[Parsed_loudnorm" or
  // similar. We do a best-effort match for the LAST complete `{...}` block.
  const match = stderrOutput.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/m)
  if (!match) {
    throw new Error('No loudnorm JSON block found in FFmpeg output')
  }
  let parsed: RawLoudnessJson
  try {
    parsed = JSON.parse(match[0])
  } catch (err) {
    throw new Error(`Failed to parse loudnorm JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const required = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const
  for (const key of required) {
    if (parsed[key] === undefined) {
      throw new Error(`Loudness measurement missing field: ${key}`)
    }
  }
  return {
    input_i: Number(parsed.input_i),
    input_tp: Number(parsed.input_tp),
    input_lra: Number(parsed.input_lra),
    input_thresh: Number(parsed.input_thresh),
    target_offset: Number(parsed.target_offset),
  }
}
