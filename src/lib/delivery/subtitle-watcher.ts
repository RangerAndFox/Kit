// @ts-nocheck
/**
 * SRT sibling generation — I/O side.
 *
 * The delivery Dropbox scan routes stable .srt files here instead of the
 * "pick a profile" prompt: download the SRT, convert (subtitle-convert.ts),
 * upload .ttml/.vtt/.txt next to it with the same basename. Uploads use
 * overwrite mode so an updated SRT can be re-processed idempotently.
 */

import { dropboxHeaders } from '../dropbox/client'
import { convertSrt, siblingPaths } from './subtitle-convert'

const CONTENT_API = 'https://content.dropboxapi.com/2'
const MAX_SRT_BYTES = 5 * 1024 * 1024 // captions are tiny; anything bigger is not an SRT

export async function downloadDropboxText(path: string): Promise<string> {
  const headers = await dropboxHeaders()
  const res = await fetch(`${CONTENT_API}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: headers.Authorization,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Dropbox download ${path}: ${res.status} ${text.slice(0, 200)}`)
  }
  return res.text()
}

export async function uploadDropboxText(path: string, content: string): Promise<void> {
  const headers = await dropboxHeaders()
  const res = await fetch(`${CONTENT_API}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: headers.Authorization,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: content,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Dropbox upload ${path}: ${res.status} ${text.slice(0, 200)}`)
  }
}

export interface SrtProcessResult {
  srtPath: string
  generated: string[] // paths written
  cueCount: number
  srtText: string // raw SRT, so callers can QC without re-downloading
}

/**
 * Download an SRT, convert, upload the three siblings alongside it.
 * Throws on unparseable/oversized SRT — the caller logs and marks the file
 * so it isn't retried forever.
 */
export async function processSrtFile(opts: {
  path: string
  sizeBytes: number
}): Promise<SrtProcessResult> {
  if (opts.sizeBytes > MAX_SRT_BYTES) {
    throw new Error(`SRT too large (${opts.sizeBytes} bytes) — skipping`)
  }
  const srtText = await downloadDropboxText(opts.path)
  const converted = convertSrt(srtText)
  const targets = siblingPaths(opts.path)

  await uploadDropboxText(targets.ttml, converted.ttml)
  await uploadDropboxText(targets.vtt, converted.vtt)
  await uploadDropboxText(targets.txt, converted.txt)

  return {
    srtPath: opts.path,
    generated: [targets.ttml, targets.vtt, targets.txt],
    cueCount: converted.cueCount,
    srtText,
  }
}
