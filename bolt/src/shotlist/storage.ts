// @ts-nocheck
/**
 * Supabase read/write for shot_lists.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'
import type { Shot } from './types'

export interface ShotListRow {
  id: string
  project_id: string | null
  slack_channel_id: string
  slack_canvas_id: string
  canvas_url: string | null
  shots_json: Shot[]
  thumbnail_permalinks: Record<number, string[]>
  last_rendered_at: string | null
}

export async function findShotListByChannel(
  channelId: string,
): Promise<ShotListRow | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('shot_lists')
    .select('*')
    .eq('slack_channel_id', channelId)
    .maybeSingle()
  if (error) {
    console.warn('[shotlist] findShotListByChannel error:', error.message)
    return null
  }
  return (data as any) || null
}

export async function upsertShotList(row: {
  project_id?: string | null
  slack_channel_id: string
  slack_canvas_id: string
  canvas_url?: string | null
  shots: Shot[]
  thumbnails?: Record<number, string[]>
}): Promise<ShotListRow | null> {
  const sb = createAdminClient()
  const payload: any = {
    project_id: row.project_id ?? null,
    slack_channel_id: row.slack_channel_id,
    slack_canvas_id: row.slack_canvas_id,
    canvas_url: row.canvas_url ?? null,
    shots_json: row.shots,
    thumbnail_permalinks: row.thumbnails || {},
    last_rendered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await sb
    .from('shot_lists')
    .upsert(payload, { onConflict: 'slack_channel_id' })
    .select('*')
    .maybeSingle()
  if (error) {
    console.warn('[shotlist] upsertShotList error:', error.message)
    return null
  }
  return (data as any) || null
}
