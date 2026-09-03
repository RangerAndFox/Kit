import path from 'node:path'

/** Refuse persistent authenticated browser state inside a Dropbox-synced tree. */
export function assertProfileOutsideSyncedStorage(profileDir: string, syncedRoot: string): void {
  const relative = path.relative(path.resolve(syncedRoot), path.resolve(profileDir))
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('BEHANCE_PROFILE_DIR must not be inside DROPBOX_SYNC_PATH; the browser profile contains persistent authenticated sessions.')
  }
}
