import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../supabase/admin'
import { dropboxRpc } from '../dropbox/client'
import { getSeenRowsByIds } from './seen-files'

export interface QueueFile { id: string; name: string; path_display: string; path_lower: string; size: number; '.tag': string; is_downloadable?: boolean }
interface Page { entries: QueueFile[]; cursor: string; has_more: boolean }
interface Pending { dropbox_id: string; path: string; size_bytes: number; stable_check_count: number }
export function isQueueInput(f: QueueFile): boolean {
  return f['.tag'] === 'file' && f.is_downloadable !== false && /^\/delivery-queue\//i.test(f.path_lower || '')
    && !/\/(delivery|output)\//i.test(f.path_lower) && !/\.tmp$|\.part$|\.crdownload$|~\$/i.test(f.name)
}
export interface QueueScanIO {
  claim(): Promise<{ claimed: boolean; cursor?: string | null }>
  page(cursor?: string | null): Promise<Page>
  record(files: QueueFile[]): Promise<void>
  checkpoint(cursor: string | null): Promise<void>
  pending(): Promise<Pending[]>
  metadata(id: string): Promise<QueueFile>
  update(id: string, fields: Record<string, unknown>): Promise<void>
  release(): Promise<void>
}

/** Two discovery pages plus twenty pending files per tick, independent of history. */
export async function runQueueScan(io: QueueScanIO): Promise<Array<{ dropbox_id: string; path: string; size_bytes: number }>> {
  const state = await io.claim()
  if (!state.claimed) return []
  const ready: Array<{ dropbox_id: string; path: string; size_bytes: number }> = []
  try {
    let cursor = state.cursor
    for (let n = 0; n < 2; n++) {
      let page: Page
      try { page = await io.page(cursor) } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (cursor && /(?:\breset\b)/i.test(message)) { await io.checkpoint(null); break }
        if (!cursor && /not_found/i.test(message)) break
        throw error
      }
      if (!page.cursor || !Array.isArray(page.entries) || typeof page.has_more !== 'boolean') throw new Error('Dropbox delta response invalid')
      await io.record(page.entries.filter(isQueueInput))
      // Persist files BEFORE advancing the cursor; failed writes replay this page.
      await io.checkpoint(page.cursor)
      cursor = page.cursor
      if (!page.has_more) break
    }
    const pending = await io.pending()
    // Four bounded provider calls at a time; last-checked ordering rotates the
    // backlog fairly even when one project has no linked notification channel.
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(pending.slice(i, i + 4).map(async previous => {
        const checked = new Date().toISOString()
        let file: QueueFile
        try { file = await io.metadata(previous.dropbox_id) } catch (error) {
          if (error instanceof Error && /not_found/i.test(error.message)) {
            await io.update(previous.dropbox_id, { delivery_queue_missing: true, delivery_queue_checked_at: checked })
            return
          }
          throw error
        }
        if (!isQueueInput(file)) {
          await io.update(previous.dropbox_id, { delivery_queue_missing: true, delivery_queue_checked_at: checked })
          return
        }
        const count = previous.size_bytes === file.size ? Math.min(2, previous.stable_check_count + 1) : 1
        await io.update(previous.dropbox_id, { path: file.path_display, size_bytes: file.size, stable_check_count: count, delivery_queue_checked_at: checked })
        if (count >= 2) ready.push({ dropbox_id: file.id, path: file.path_display, size_bytes: file.size })
      }))
    }
    // A worker whose lease was reclaimed may not return notifications.
    await io.release()
    return ready
  } catch (error) {
    await io.release().catch(() => {})
    throw error
  }
}

export function queueScanIO(): QueueScanIO {
  const sb = createAdminClient() as unknown as SupabaseClient
  const owner = randomUUID()
  const cursorCall = async (action: string, cursor?: string | null) => {
    const { data, error } = await sb.rpc('delivery_queue_cursor', { p_owner: owner, p_action: action, p_cursor: cursor ?? null })
    if (error) throw new Error('Delivery queue cursor operation failed')
    return data
  }
  const update = async (id: string, fields: Record<string, unknown>) => {
    const { error } = await sb.from('seen_dropbox_files').update(fields).eq('dropbox_id', id)
    if (error) throw new Error('Delivery queue stability update failed')
  }
  return {
    claim: () => cursorCall('claim'), checkpoint: async cursor => { await cursorCall('checkpoint', cursor) },
    release: async () => { await cursorCall('release') },
    page: cursor => dropboxRpc(cursor ? '/files/list_folder/continue' : '/files/list_folder', cursor ? { cursor } : {
      path: '/Delivery-Queue', recursive: true, include_deleted: true, include_non_downloadable_files: false, limit: 200,
    }),
    async record(files) {
      const existing = await getSeenRowsByIds(files.map(f => f.id))
      const first = files.filter(f => !existing[f.id]).map(f => ({ dropbox_id: f.id, path: f.path_display, size_bytes: f.size, stable_check_count: 0 }))
      if (first.length) {
        const { error } = await sb.from('seen_dropbox_files').upsert(first, { onConflict: 'dropbox_id', ignoreDuplicates: true })
        if (error) throw new Error('Delivery queue discovery could not be saved')
      }
      const changed = files.filter(f => existing[f.id] && (existing[f.id].path !== f.path_display || existing[f.id].delivery_queue_missing || existing[f.id].size_bytes !== f.size))
      for (let i = 0; i < changed.length; i += 8) await Promise.all(changed.slice(i, i + 8).map(file => update(file.id, {
        path: file.path_display, delivery_queue_missing: false,
        ...(existing[file.id].size_bytes !== file.size ? { size_bytes: file.size, stable_check_count: 0 } : {}),
      })))
    },
    async pending() {
      const { data, error } = await sb.from('seen_dropbox_files').select('dropbox_id,path,size_bytes,stable_check_count')
        .ilike('path', '/Delivery-Queue/%').is('notified_at', null).eq('delivery_queue_missing', false)
        .order('delivery_queue_checked_at', { ascending: true, nullsFirst: true }).order('dropbox_id').limit(20)
      if (error) throw new Error('Delivery queue pending work unavailable')
      return data || []
    },
    metadata: id => dropboxRpc('/files/get_metadata', { path: id }), update,
  }
}
