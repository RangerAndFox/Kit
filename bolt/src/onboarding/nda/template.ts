/**
 * NDA documents.
 *
 * Two NDAs live in bolt/assets/nda:
 *  - Individual — a static PDF (letterhead), signed/printed/dated by hand.
 *    No fields to fill; loaded via loadNdaPdf().
 *  - Company — a .docx with literal [day] [month] [year] [company] placeholders.
 *    Filled via fillCompanyNdaDocx(), then converted to PDF before emailing.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// bolt/src/onboarding/nda/template.ts → bolt/assets/nda/<file>
export const NDA_PDF_PATH = path.resolve(
  __dirname,
  '../../../assets/nda/RF_One_Way_Individual_NDA.pdf',
)
export const NDA_COMPANY_TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../../assets/nda/RF_One_Way_Company_NDA.template.docx',
)

const PDF_CONTENT_TYPE = 'application/pdf'
const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export interface NdaDocument {
  buffer: Buffer
  filename: string
  contentType: string
}

function safeFilenamePart(s: string): string {
  return s.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0])
}

/**
 * Format a date into the Company NDA's day/month/year parts, in the studio's
 * timezone (so an evening send near midnight doesn't roll the date). `day` is
 * an ordinal ("25th") to read naturally in "made as of this 25th day of …".
 */
export function formatNdaDateParts(
  date: Date,
  timeZone = 'America/Los_Angeles',
): { day: string; month: string; year: string } {
  const dayNum = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric' }).format(date),
  )
  const month = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long' }).format(date)
  const year = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(date)
  return { day: ordinal(dayNum), month, year }
}

/**
 * Load the static Individual NDA PDF. `recipientName` only flavors the
 * attachment filename; the PDF bytes are identical for everyone.
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

/**
 * Fill the Company NDA .docx. The template uses square-bracket placeholders
 * ([day] [month] [year] [company]/[Company]); we set docxtemplater's delimiters
 * to match. Returns a filled .docx — convert to PDF before emailing.
 */
export function fillCompanyNdaDocx(
  data: { company: string; date?: Date },
  opts: { templatePath?: string } = {},
): NdaDocument {
  const templatePath = opts.templatePath || NDA_COMPANY_TEMPLATE_PATH
  const content = fs.readFileSync(templatePath)
  const zip = new PizZip(content)
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '[', end: ']' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  })
  const parts = formatNdaDateParts(data.date || new Date())
  doc.render({
    day: parts.day,
    month: parts.month,
    year: parts.year,
    company: data.company,
    Company: data.company,
  })
  const buffer = doc.getZip().generate({ type: 'nodebuffer' }) as Buffer
  return {
    buffer,
    filename: `NDA_RangerFox_${safeFilenamePart(data.company) || 'Company'}.docx`,
    contentType: DOCX_CONTENT_TYPE,
  }
}
