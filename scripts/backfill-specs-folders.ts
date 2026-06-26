/**
 * One-shot: create the delivery watch folders (specs/video + specs/audio) in
 * every existing project under /production on Dropbox.
 *
 * New projects get these automatically at provision time (see
 * src/lib/inngest/agents/dropbox.ts ensureSpecsFolders); this backfills the
 * projects that already exist.
 *
 * Run where the Dropbox creds live (Railway shell or local with .env):
 *   npx tsx scripts/backfill-specs-folders.ts
 *
 * Requires DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN.
 */

import 'dotenv/config'
import { dropboxHeaders } from '../src/lib/dropbox/client'

const DROPBOX_API = 'https://api.dropboxapi.com/2'

async function dbx(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: await dropboxHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${endpoint} ${res.status}: ${text}`)
  }
  return res.json()
}

/** List immediate child folders of a path. */
async function listFolders(path: string): Promise<string[]> {
  const out: string[] = []
  let resp = await dbx('/files/list_folder', { path, recursive: false })
  const collect = (r: any) => {
    for (const e of r.entries || []) {
      if (e['.tag'] === 'folder' && e.path_display) out.push(e.path_display)
    }
  }
  collect(resp)
  while (resp.has_more) {
    resp = await dbx('/files/list_folder/continue', { cursor: resp.cursor })
    collect(resp)
  }
  return out
}

async function ensureSpecsFolders(projectPath: string): Promise<void> {
  for (const sub of ['specs', 'specs/video', 'specs/audio']) {
    try {
      await dbx('/files/create_folder_v2', { path: `${projectPath}/${sub}`, autorename: false })
    } catch (err: any) {
      if (!/conflict/i.test(err?.message || '')) throw err
    }
  }
}

async function main() {
  const years = await listFolders('/production')
  let projects = 0
  for (const year of years) {
    const projectFolders = await listFolders(year)
    for (const p of projectFolders) {
      await ensureSpecsFolders(p)
      projects++
      console.log(`✓ specs/{video,audio} ensured in ${p}`)
    }
  }
  console.log(`\nDone — ${projects} project folder(s) across ${years.length} year(s).`)
}

main().catch((err) => {
  console.error('backfill-specs-folders failed:', err.message || err)
  process.exit(1)
})
