// @ts-nocheck
/**
 * Convert a filled NDA .docx into a PDF using the studio's Google service
 * account — the same GOOGLE_SERVICE_ACCOUNT_JSON used to send the NDA email.
 *
 * Flow: upload the .docx to Drive *as a Google Doc* (Drive converts on import,
 * preserving the letterhead) → export it as PDF → delete the temp file. No
 * googleapis package, no LibreOffice — just REST, matching mailer.ts.
 *
 * Requires the service account's domain-wide delegation to also authorize
 *   https://www.googleapis.com/auth/drive
 * (one-time, in Google Workspace Admin), impersonating ONBOARDING_FROM_EMAIL.
 * Until that's done, callers fall back to sending the .docx.
 */

import crypto from 'node:crypto'
import { getDelegatedAccessToken } from './mailer'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true'

/**
 * Convert a .docx buffer to a PDF buffer. Throws on any failure so the caller
 * can fall back to the .docx.
 */
export async function convertDocxToPdf(opts: {
  docxBuffer: Buffer
  /** Name for the temp Drive file (no extension). */
  name: string
  /** Workspace user to impersonate — owns the transient file. */
  subject: string
}): Promise<Buffer> {
  const token = await getDelegatedAccessToken(DRIVE_SCOPE, opts.subject)

  // 1. Upload the .docx, converting to a Google Doc on import.
  const boundary = `kit_nda_pdf_${crypto.randomBytes(8).toString('hex')}`
  const meta = JSON.stringify({ name: opts.name, mimeType: GOOGLE_DOC_MIME })
  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\nContent-Transfer-Encoding: base64\r\n\r\n`
  const post = `\r\n--${boundary}--`
  const body = Buffer.concat([
    Buffer.from(pre, 'utf8'),
    Buffer.from(opts.docxBuffer.toString('base64'), 'utf8'),
    Buffer.from(post, 'utf8'),
  ])

  const upRes = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
  if (!upRes.ok) {
    throw new Error(`Drive upload failed (${upRes.status}): ${await upRes.text()}`)
  }
  const upData: any = await upRes.json()
  const fileId: string | undefined = upData.id
  if (!fileId) throw new Error('Drive upload returned no file id')

  try {
    // 2. Export the Google Doc as PDF.
    const exRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!exRes.ok) {
      throw new Error(`Drive export failed (${exRes.status}): ${await exRes.text()}`)
    }
    return Buffer.from(await exRes.arrayBuffer())
  } finally {
    // 3. Always clean up the temp Drive file (best-effort).
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    ).catch(() => {})
  }
}
