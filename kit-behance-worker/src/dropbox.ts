import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

function localDropboxPath(cloudPath: string): string {
  const relative = cloudPath.replace(/^\/+/, '')
  const resolved = path.resolve(config.dropboxSyncPath, relative)
  const root = `${config.dropboxSyncPath}${path.sep}`
  if (!resolved.startsWith(root)) throw new Error(`Dropbox path escaped the configured sync root: ${cloudPath}`)
  return resolved
}

export async function downloadFiles(paths: string[], directory: string): Promise<string[]> {
  const output: string[] = []
  for (let index = 0; index < paths.length; index++) {
    const cloudPath = paths[index]
    const sourcePath = localDropboxPath(cloudPath)
    const safeName = `${String(index + 1).padStart(2, '0')}_${path.basename(cloudPath).replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const localPath = path.join(directory, safeName)
    try {
      // Reading the File Provider path hydrates online-only Dropbox files.
      await fs.copyFile(sourcePath, localPath)
    } catch (error: any) {
      throw new Error(`Dropbox Sync could not read ${cloudPath}: ${error?.message || error}`)
    }
    output.push(localPath)
  }
  return output
}

export async function uploadProof(localPath: string, cloudFolder: string): Promise<{ path: string; url: string | null }> {
  const proofFolder = `${cloudFolder.replace(/\/$/, '')}/Behance`
  const cloudPath = `${proofFolder}/Kit_Behance_Draft_Proof.png`
  const localFolder = localDropboxPath(proofFolder)
  await fs.mkdir(localFolder, { recursive: true })
  await fs.copyFile(localPath, localDropboxPath(cloudPath))
  // Kit's cloud process creates the team-only shared link after Dropbox Sync
  // uploads the proof, so this trusted machine needs no Dropbox API token.
  return { path: cloudPath, url: null }
}
