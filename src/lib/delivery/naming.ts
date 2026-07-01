/**
 * Apply a naming template to a NamingFields object.
 *
 * Template: "{session}_{speaker}_V{version}_{event}"
 * Fields:   { session: "STUDIO100", speaker: "BradS", version: "1", event: "Ignite25" }
 * Output:   "STUDIO100_BradS_V1_Ignite25"
 *
 * Missing fields render as empty; consecutive separators are collapsed.
 */

import type { NamingFields } from './types'

/**
 * Strip anything filesystem-meaningful from a substituted field value.
 * Field values arrive from Slack input and end up joined into an output
 * PATH on the render workers — without this, "..\\..\\evil" writes the
 * transcode anywhere the worker user can write. Kept in sync with the
 * standalone copy in kit-render-worker/src/ffmpeg/naming.ts.
 */
function sanitizeFieldValue(v: string): string {
  return v
    .replace(/[/\\]/g, '_') // path separators
    .replace(/\.{2,}/g, '_') // parent-dir sequences
    .replace(/[<>:"|?*]/g, '_') // Windows-reserved characters
}

export function applyNamingTemplate(template: string, fields: NamingFields): string {
  let out = template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = fields[key]
    return v == null ? '' : sanitizeFieldValue(String(v))
  })
  // Collapse multiple underscores from missing fields ("STUDIO100__BradS" → "STUDIO100_BradS").
  out = out.replace(/_+/g, '_')
  // Trim leading/trailing underscores.
  out = out.replace(/^_+|_+$/g, '')
  return out
}

export function buildOutputFilename(
  template: string,
  fields: NamingFields,
  container: string,
): string {
  const base = applyNamingTemplate(template, fields)
  const ext = container.startsWith('.') ? container : `.${container}`
  return `${base}${ext}`
}
