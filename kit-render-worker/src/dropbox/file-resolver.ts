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
import { resolvePathUnderRoot } from './path-safety'

export interface ResolvedFile {
  localPath: string
  sizeBytes: number
}

function realPathIsContained(root: string, candidate: string): boolean {
  const realRoot = fs.realpathSync(root)
  const realCandidate = fs.realpathSync(candidate)
  const relative = path.relative(realRoot, realCandidate)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function resolveDropboxPath(dropboxPath: string): ResolvedFile | null {
  if (!config.dropboxSyncPath) return null
  const local = resolvePathUnderRoot(config.dropboxSyncPath, dropboxPath)
  if (!local) return null
  if (!fs.existsSync(local)) return null
  if (!realPathIsContained(config.dropboxSyncPath, local)) return null
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
  const local = resolvePathUnderRoot(config.dropboxSyncPath, dropboxDir)
  if (!local) return null
  fs.mkdirSync(local, { recursive: true })
  if (!realPathIsContained(config.dropboxSyncPath, local)) return null
  return local
}
