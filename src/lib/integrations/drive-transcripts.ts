// @ts-nocheck
/**
 * Google Drive transcript source.
 *
 * A Zapier zap drops Plaud call transcripts into a shared Drive folder.
 * Kit ingests from that folder instead of requiring the Plaud webhook API:
 * the driveTranscriptScan cron lists new files, downloads their text, and
 * feeds the same classify → store → embed pipeline the webhook path uses.
 *
 * Auth: the existing GOOGLE_SERVICE_ACCOUNT_JSON service account, with the
 * drive.readonly scope. The folder must be SHARED with the service account
 * (Viewer) or every list call returns empty/403.
 *
 * Env:
 *   DRIVE_TRANSCRIPTS_ENABLED     — 'true' to activate the cron
 *   DRIVE_TRANSCRIPTS_FOLDER_ID   — the Drive folder id the zap writes into
 */

import { google } from 'googleapis'

export interface DriveTranscriptFile {
  id: string
  name: string
  mimeType: string
  createdTime: string
  modifiedTime: string
}

export function driveTranscriptsEnabled(): boolean {
  return process.env.DRIVE_TRANSCRIPTS_ENABLED === 'true'
}

export function driveTranscriptsFolderId(): string | null {
  return process.env.DRIVE_TRANSCRIPTS_FOLDER_ID?.trim() || null
}

function getServiceAccountCreds(): any {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  return JSON.parse(json)
}

function getDriveClient() {
  const creds = getServiceAccountCreds()
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  })
  return google.drive({ version: 'v3', auth })
}

/** List transcript files in the watched folder, newest first. */
export async function listTranscriptFiles(limit = 25): Promise<DriveTranscriptFile[]> {
  const folderId = driveTranscriptsFolderId()
  if (!folderId) return []
  const drive = getDriveClient()
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: 'createdTime desc',
    pageSize: limit,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    // Shared-drive tolerance — harmless for My Drive folders.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return (res.data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name || '(untitled)',
    mimeType: f.mimeType || '',
    createdTime: f.createdTime || '',
    modifiedTime: f.modifiedTime || '',
  }))
}

/**
 * Strip the HTML remnants the Zapier zap leaves in transcript docs
 * (`<br>` line breaks, stray tags, entities) so stored transcripts, briefing
 * snippets, and embeddings read as plain text. Pure — tested.
 */
export function sanitizeTranscriptText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Download a transcript file's text. Google Docs export as text/plain;
 * plain-text-ish files download raw. Unsupported types (PDF scans, audio)
 * return null so the caller can skip with a log instead of erroring.
 */
export async function downloadTranscriptText(file: DriveTranscriptFile): Promise<string | null> {
  const drive = getDriveClient()

  if (file.mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'text' },
    )
    return typeof res.data === 'string' ? res.data : String(res.data ?? '')
  }

  if (
    file.mimeType.startsWith('text/') ||
    file.mimeType === 'application/json' ||
    /\.(txt|md|vtt|srt|json)$/i.test(file.name)
  ) {
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'text' },
    )
    return typeof res.data === 'string' ? res.data : String(res.data ?? '')
  }

  return null // unsupported type (pdf/docx/audio) — skipped, logged by caller
}
