/**
 * NDA document loader.
 *
 * Loads the committed Ranger & Fox one-way *Individual* NDA (a static PDF with
 * the studio letterhead). The document is not personalized — it's a blank NDA
 * the freelancer signs, prints their name on, and dates themselves. We only
 * vary the attachment filename per recipient.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// bolt/src/onboarding/nda/template.ts → bolt/assets/nda/<file>.pdf
export const NDA_PDF_PATH = path.resolve(
  __dirname,
  '../../../assets/nda/RF_One_Way_Individual_NDA.pdf',
)

const PDF_CONTENT_TYPE = 'application/pdf'

export interface NdaDocument {
  buffer: Buffer
  filename: string
  contentType: string
}

function safeFilenamePart(s: string): string {
  return s.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
}

/**
 * Load the NDA PDF to attach to an onboarding email. Synchronous — the PDF is
 * a small local file. Throws if the asset is missing.
 *
 * `recipientName` only flavors the attachment filename
 * (e.g. NDA_RangerFox_Jane_Doe.pdf); the PDF bytes are identical for everyone.
 */
export function loadNdaPdf(
  opts: { recipientName?: string; pdfPath?: string } = {},
): NdaDocument {
  const buffer = fs.readFileSync(opts.pdfPath || NDA_PDF_PATH)
  const who = opts.recipientName ? safeFilenamePart(opts.recipientName) : ''
  return {
    buffer,
    filename: who ? `NDA_RangerFox_${who}.pdf` : 'NDA_RangerFox.pdf',
    contentType: PDF_CONTENT_TYPE,
  }
}
