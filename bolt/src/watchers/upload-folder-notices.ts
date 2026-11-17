import { randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { uploadReviewers } from '../../../src/lib/delivery/upload-approval'
import { getUploadApproval } from '../../../src/lib/delivery/upload-approval-store'
import { folderSuggestedBase, uploadDate, type FolderContext } from '../../../src/lib/delivery/upload-folder'
import { folderRpc, prepareUploadFolder } from '../../../src/lib/delivery/upload-folder-store'
import { deliverSlackOnce } from '../../../src/lib/slack/durable-delivery'
import { collisionCard } from './upload-collision'
import { uploadFolderCard } from './upload-folder-card'

/** One durable Slack receipt and sender lease per outgoing batch folder. */
export async function syncUploadFolderNotices(app: App, requestId?: string): Promise<void> {
  const groups = await folderRpc<Array<{ project_id: string; folder_path: string }>>('list_frame_upload_folder_notices', { p_request: requestId || null })
  for (const group of groups || []) {
    const token = randomUUID()
    let context: FolderContext | undefined, leased = false, success = false
    try {
      context = await prepareUploadFolder(group.project_id, group.folder_path)
      leased = await folderRpc<boolean>('claim_frame_upload_folder_notice', { p_id: context.folder.id, p_token: token })
      if (!leased) continue
      context = await prepareUploadFolder(group.project_id, group.folder_path)
      const { folder } = context
      if (!folder.slack_message_ts && !context.files.some(f => ['awaiting', 'collision'].includes(f.state))) {
        success = true
        continue // Do not replay terminal history as a new notification.
      }
      const db = createAdminClient() as unknown as SupabaseClient
      const { data: project, error } = await db.from('projects').select('project_manager_slack_id,external_ids,project_code,name,client')
        .eq('id', folder.project_id).eq('workspace_id', folder.workspace_id).single()
      if (error || !project) throw new Error('Folder project unavailable')
      const users = uploadReviewers(project)
      if (!users.length) throw new Error('No project reviewers configured')
      const channel = (await app.client.conversations.open({ users: users.join(',') })).channel?.id
      if (!channel || (folder.slack_channel_id && folder.slack_channel_id !== channel) ||
        context.slots.some(s => s.slack_channel_id && s.slack_channel_id !== channel)) throw new Error('Private reviewer group changed')
      const save = async (ts?: string) => {
        if (!await folderRpc<boolean>('save_frame_upload_folder_notice', { p_id: folder.id, p_token: token, p_channel: channel, p_ts: ts || null })) throw new Error('Folder sender lease changed')
      }
      await save()
      const content = uploadFolderCard(context, `${project.project_code} — ${project.name}`,
        folderSuggestedBase(project.client, project.name, folder.folder_path), uploadDate())
      let ts = folder.slack_message_ts
      if (ts) await app.client.chat.update({ channel, ts, ...content })
      else ts = await deliverSlackOnce({ key: `frame-upload-folder:${folder.id}`, channel, ...content })
      if (!ts) throw new Error('Missing Slack receipt')
      await save(ts)
      // Close previous individual cards in place. Never delete history or repost them.
      const old = [
        ...context.slots.filter(s => !s.folder_notice_closed),
        ...context.legacy,
      ]
      const edited = new Set<string>()
      let legacyClean = true
      for (const copy of old) {
        if (!copy.slack_channel_id || !copy.slack_message_ts || copy.slack_message_ts === ts) continue
        const key = `${copy.slack_channel_id}:${copy.slack_message_ts}`
        if (edited.has(key)) continue
        await save()
        try {
          await app.client.chat.update({ channel: copy.slack_channel_id, ts: copy.slack_message_ts,
          text: 'Grouped into the folder upload request.', blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Use the shared folder request’s UPLOAD TO FRAME or CANCEL UPLOAD buttons. This individual request no longer needs a separate approval.' } }] })
        } catch {
          legacyClean = false
          console.warn('[upload-folder] Individual card cleanup deferred', copy.id)
        }
        edited.add(key)
      }
      // Actual same-name conflicts still belong only to the original approver.
      for (const dirty of context.dirty) {
        const row = await getUploadApproval(dirty.id)
        if (row.project_id !== folder.project_id || row.workspace_id !== folder.workspace_id) throw new Error('Folder outcome scope changed')
        if (row.state !== 'collision' && !row.collision_message_ts) continue
        if (!row.approved_by) throw new Error('Missing collision owner')
        const dm = row.collision_channel_id || (await app.client.conversations.open({ users: row.approved_by })).channel?.id
        if (!dm) throw new Error('Approver DM unavailable')
        const card = collisionCard(row)
        let collisionTs = row.collision_message_ts
        await save()
        if (collisionTs) await app.client.chat.update({ channel: dm, ts: collisionTs, ...card })
        else collisionTs = await deliverSlackOnce({ key: `frame-upload-collision:${row.id}`, channel: dm, ...card })
        const result = await db.from('frame_upload_approvals').update({ collision_channel_id: dm, collision_message_ts: collisionTs })
          .eq('id', row.id).eq('workspace_id', folder.workspace_id).eq('approved_by', row.approved_by)
        if (result.error) throw new Error('Collision receipt checkpoint failed')
      }
      success = legacyClean
    } catch {
      console.warn('[upload-folder] Folder card refresh deferred', group.project_id)
    } finally {
      if (context && leased) await folderRpc('finish_frame_upload_folder_notice', {
        p_id: context.folder.id, p_token: token, p_generation: context.folder.generation, p_success: success, p_seen: context.dirty,
      })
    }
  }
}
