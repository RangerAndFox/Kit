import { randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { uploadReviewers } from '../../../src/lib/delivery/upload-approval'
import type { UploadReviewPackage } from '../../../src/lib/delivery/upload-package'
import { getUploadPackagePage } from '../../../src/lib/delivery/upload-package-store'
import { deliverSlackOnce } from '../../../src/lib/slack/durable-delivery'
import { uploadPackageCard } from './upload-package-card'

/** The existing Railway sweep owns this bounded, independent notification
 * outbox. A file acknowledgment never clears a package's dirty generation. */
export async function syncUploadPackageNotices(app: App, requestId?: string): Promise<void> {
  const db = createAdminClient() as unknown as SupabaseClient
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(name, args)
    if (error) throw new Error('Delivery folder notification checkpoint unavailable')
    return data as T
  }
  const packages = await rpc<UploadReviewPackage[]>('list_pending_frame_upload_packages', { p_request: requestId || null })
  for (const snapshot of packages || []) {
    const token = randomUUID()
    let claimed = false, success = false, generation = snapshot.generation
    try {
      claimed = await rpc<boolean>('claim_frame_upload_package_notice', { p_id: snapshot.id, p_token: token })
      if (!claimed) continue
      const page = await getUploadPackagePage(snapshot.id)
      const pack = page.package
      generation = pack.generation
      if (pack.blocked_reason || pack.workspace_id !== snapshot.workspace_id || pack.project_id !== snapshot.project_id) {
        throw new Error('Delivery folder routing requires review')
      }
      const { data: project, error } = await db.from('projects').select('project_manager_slack_id,external_ids,project_code,name,status')
        .eq('id', pack.project_id).eq('workspace_id', pack.workspace_id).single()
      if (error || !project || ['archived', 'cancelled'].includes(project.status)) throw new Error('Delivery project unavailable')
      const users = uploadReviewers(project)
      if (!users.length) throw new Error('Delivery reviewers unavailable')
      const channel = (await app.client.conversations.open({ users: users.join(',') })).channel?.id
      if (!channel || (pack.slack_channel_id && pack.slack_channel_id !== channel)) throw new Error('Delivery reviewer group changed')
      const save = async (ts?: string) => {
        if (!await rpc<boolean>('save_frame_upload_package_receipt', { p_id: pack.id, p_token: token, p_channel: channel, p_ts: ts || null })) {
          throw new Error('Delivery package lease or receipt changed')
        }
      }
      await save()
      const content = uploadPackageCard(page, `${project.project_code} — ${project.name}`)
      let ts = pack.slack_message_ts
      if (!ts) ts = await deliverSlackOnce({ key: `frame-upload-package:${pack.id}`, channel, ...content })
      if (!ts) throw new Error('Slack returned no delivery folder receipt')
      await save(ts)
      // A recovered durable send may contain an older generation. Refresh its
      // exact receipt before acknowledging the snapshot, without another ping.
      await app.client.chat.update({ channel, ts, ...content })
      success = true
    } catch {
      console.warn('[upload-review] Delivery folder card refresh deferred', snapshot.id)
    } finally {
      if (claimed) await rpc('finish_frame_upload_package_notice', {
        p_id: snapshot.id, p_token: token, p_generation: generation, p_success: success,
      })
    }
  }
}
