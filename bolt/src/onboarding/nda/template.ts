/**
 * NDA template fill.
 *
 * Loads the committed Ranger & Fox one-way NDA (.docx, letterhead preserved)
 * and merges in the artist's details via docxtemplater. The template carries
 * four single-brace merge tags authored into the original document:
 *   {company_name}  — the "Company" signing party
 *   {day} {month} {year} — the "made as of this ___ day of ___ ____" date
 *
 * Output is a filled .docx (the artist signs in Word / Google Docs / on paper).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// bolt/src/onboarding/nda/template.ts → bolt/assets/nda/<template>.docx
export const NDA_TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../../assets/nda/RF_One_Way_Company_NDA.template.docx',
)

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export interface NdaMergeData {
  /** The "Company" party — legal entity name, or the artist's full name. */
  companyName: string
  /** Effective date of the agreement. Defaults to now. */
  date?: Date
}

export interface FilledNda {
  buffer: Buffer
  filename: string
  contentType: string
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0])
}

/**
 * Format a date into the NDA's day/month/year parts, in the studio's
 * timezone (so an evening send near midnight doesn't roll the date).
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

function safeFilenamePart(s: string): string {
  return s.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Company'
}

/**
 * Produce a filled NDA .docx for one artist. Synchronous — the template is a
 * small local file. Throws if the template is missing or merge fails.
 */
export function fillNdaTemplate(
  data: NdaMergeData,
  opts: { templatePath?: string } = {},
): FilledNda {
  const templatePath = opts.templatePath || NDA_TEMPLATE_PATH
  const content = fs.readFileSync(templatePath)
  const zip = new PizZip(content)
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true })
  const parts = formatNdaDateParts(data.date || new Date())
  doc.render({
    company_name: data.companyName,
    day: parts.day,
    month: parts.month,
    year: parts.year,
  })
  const buffer = doc.getZip().generate({ type: 'nodebuffer' }) as Buffer
  return {
    buffer,
    filename: `NDA_RangerFox_${safeFilenamePart(data.companyName)}.docx`,
    contentType: DOCX_CONTENT_TYPE,
  }
}
