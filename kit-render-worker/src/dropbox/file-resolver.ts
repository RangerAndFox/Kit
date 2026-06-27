// @ts-nocheck
/**
 * Resolve a Dropbox-path (e.g. "/Delivery-Queue/Ignite/intro.mov") to a local
 * filesystem path under the worker's DROPBOX_SYNC_PATH.
 *
 * v1 only supports locally-synced files (no API download fallback). If the
 * file doesn't exist locally, returns null and the worker fails the job with
 * a clear error message asking the operator to ensure Dropbox is synced.
 */

import * as fs from 'fs'
import * as path from 'path'
import { config } from '../config'

export interface ResolvedFile {
  localPath: string
  sizeBytes: number
}

export function resolveDropboxPath(dropboxPath: string): ResolvedFile | null {
  if (!config.dropboxSyncPath) return null
  // Normalize Dropbox paths (start with /) to relative under the sync root.
  const rel = dropboxPath.replace(/^\/+/, '').replace(/\//g, path.sep)
  const local = path.join(config.dropboxSyncPath, rel)
  if (!fs.existsSync(local)) return null
  const stat = fs.statSync(local)
  if (!stat.isFile()) return null
  return { localPath: local, sizeBytes: stat.size }
}

export function ensureOutputDir(outputPath: string): void {
  const dir = path.dirname(outputPath)
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Map a Dropbox directory path to its local equivalent under DROPBOX_SYNC_PATH,
 * creating it if necessary. Unlike resolveDropboxPath this does NOT require the
 * path to already exist — it's used for render output folders.
 */
export function resolveDropboxDir(dropboxDir: string): string | null {
  if (!config.dropboxSyncPath) return null
  const rel = dropboxDir.replace(/^\/+/, '').replace(/\//g, path.sep)
  const local = path.join(config.dropboxSyncPath, rel)
  fs.mkdirSync(local, { recursive: true })
  return local
}
