import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

let token = ''
let tokenExpiresAt = 0

async function accessToken(): Promise<string> {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.dropboxRefreshToken, client_id: config.dropboxAppKey, client_secret: config.dropboxAppSecret }),
  })
  const body = await response.json() as any
  if (!response.ok || !body.access_token) throw new Error(`Dropbox token refresh failed: ${body.error_description || response.status}`)
  token = body.access_token
  tokenExpiresAt = Date.now() + Number(body.expires_in || 14400) * 1000
  return token
}

export async function downloadFiles(paths: string[], directory: string): Promise<string[]> {
  const output: string[] = []
  for (let index = 0; index < paths.length; index++) {
    const cloudPath = paths[index]
    const linkResponse = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cloudPath }),
    })
    const linkBody = await linkResponse.json() as any
    if (!linkResponse.ok || !linkBody.link) throw new Error(`Dropbox could not prepare ${cloudPath}: ${linkBody.error_summary || linkResponse.status}`)
    const source = await fetch(linkBody.link)
    if (!source.ok) throw new Error(`Dropbox download failed for ${cloudPath}: ${source.status}`)
    const safeName = `${String(index + 1).padStart(2, '0')}_${path.basename(cloudPath).replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const localPath = path.join(directory, safeName)
    await fs.writeFile(localPath, Buffer.from(await source.arrayBuffer()))
    output.push(localPath)
  }
  return output
}

export async function uploadProof(localPath: string, cloudFolder: string): Promise<{ path: string; url: string | null }> {
  const proofFolder = `${cloudFolder.replace(/\/$/, '')}/Behance`
  const createFolder = await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: proofFolder, autorename: false }),
  })
  if (!createFolder.ok) {
    const folderError = await createFolder.text()
    if (!/conflict/i.test(folderError)) throw new Error(`Dropbox proof folder failed: ${folderError}`)
  }
  const cloudPath = `${proofFolder}/Kit_Behance_Draft_Proof.png`
  const bytes = await fs.readFile(localPath)
  const upload = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: cloudPath, mode: 'overwrite', autorename: false, mute: true }) },
    body: bytes,
  })
  if (!upload.ok) throw new Error(`Dropbox proof upload failed: ${await upload.text()}`)
  const shared = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cloudPath }),
  })
  const body = await shared.json() as any
  if (shared.ok && body.url) return { path: cloudPath, url: body.url }
  if (body.error?.['.tag'] !== 'shared_link_already_exists') return { path: cloudPath, url: null }
  const listed = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cloudPath, direct_only: true }),
  })
  const listedBody = await listed.json() as any
  return { path: cloudPath, url: listedBody.links?.[0]?.url || null }
}
