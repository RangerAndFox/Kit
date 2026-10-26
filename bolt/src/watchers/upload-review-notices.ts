import { randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { getUploadApproval, uploadApprovalsEnabled } from '../../../src/lib/delivery/upload-approval-store'
import { uploadReviewers, type UploadApproval } from '../../../src/lib/delivery/upload-approval'
import { deliverSlackOnce } from '../../../src/lib/slack/durable-delivery'
import { reconcilePendingUploadApproval } from './dropbox'
import { uploadApprovalCard } from './upload-approval-card'
import { collisionCard } from './upload-collision'

type Slot = { id:string;workspace_id:string;project_id:string;current_approval_id:string;anchor_approval_id:string;generation:number;slack_channel_id:string|null;slack_message_ts:string|null }
type Context = {slot:Slot;current:UploadApproval;completed:UploadApproval|null;legacy:UploadApproval[];dirty_approvals:Array<{id:string;updated_at:string}>}

/** Existing Railway outbox, coalesced by logical file. Registration/outcome
 * rows stay immutable approval identities; only the shared card is replaced. */
export async function syncUploadApprovalNotices(app:App,requestId?:string):Promise<void> {
  if(!uploadApprovalsEnabled()) return
  const db=createAdminClient() as unknown as SupabaseClient
  const rpc=async<T>(name:string,args:Record<string,unknown>):Promise<T>=>{
    const {data,error}=await db.rpc(name,args)
    if(error) throw new Error(`Upload review checkpoint failed: ${name}`)
    return data as T
  }
  const requireReceipt=async(name:string,args:Record<string,unknown>)=>{
    if(!await rpc<boolean>(name,args)) throw new Error('Upload review lease or receipt changed')
  }
  let dirty=db.from('frame_upload_approvals').select('id,review_slot_id').eq('notice_dirty',true).is('review_slot_id',null).order('updated_at').limit(10)
  if(requestId) dirty=dirty.eq('id',requestId)
  const {data:pending,error:pendingError}=await dirty
  if(pendingError) throw new Error('Upload review outcome outbox unavailable')
  for(const entry of (pending||[]) as Array<{id:string;review_slot_id:string|null}>) {
    if(!entry.review_slot_id) {
      // An old process may insert during a rolling deploy. Adopt only after
      // re-verifying its exact source, never by manufacturing a receipt.
      try {
        const row=await getUploadApproval(entry.id)
        await reconcilePendingUploadApproval(row)
        const fresh=await getUploadApproval(entry.id)
        if(!fresh.review_slot_id) throw new Error('Legacy review needs reconciliation')
      } catch { console.warn('[upload-review] Legacy request needs reconciliation',entry.id) }
    }
  }
  const rows=await rpc<Slot[]>('list_pending_frame_upload_reviews',{p_request:requestId||null})
  for(const snapshot of rows||[]) {
    const token=randomUUID()
    let context:Context|null=null,success=false,deferred=false
    try {
      // Reconcile legacy stale cards only with a fresh exact-source read.
      const pendingRow=await getUploadApproval(snapshot.current_approval_id)
      if(pendingRow.state==='awaiting') await reconcilePendingUploadApproval(pendingRow)
      context=await rpc<Context|null>('claim_frame_upload_review_slot',{p_id:snapshot.id,p_token:token})
      if(!context) continue
      const {slot}=context
      const row=await getUploadApproval(context.current.id)
      if(row.workspace_id!==slot.workspace_id||row.project_id!==slot.project_id||row.review_slot_id!==slot.id) throw new Error('Upload review workspace mismatch')
      const {data:project,error:projectError}=await db.from('projects').select('project_manager_slack_id,external_ids,project_code,name')
        .eq('id',row.project_id).eq('workspace_id',row.workspace_id).single()
      if(projectError||!project) throw new Error('Upload reviewer project unavailable')
      const users=uploadReviewers(project)
      if(!users.length) throw new Error('No project reviewers configured')
      const channel=(await app.client.conversations.open({users:users.join(',')})).channel?.id
      if(!channel||(slot.slack_channel_id&&slot.slack_channel_id!==channel)) throw new Error('Review recipient group changed; private destination review required')
      await requireReceipt('save_frame_upload_review_receipt',{p_id:slot.id,p_token:token,p_channel:channel})
      const content=uploadApprovalCard(row,`${project.project_code} — ${project.name}`,context.completed)
      let ts=slot.slack_message_ts
      if(ts) await app.client.chat.update({channel,ts,...content})
      else ts=await deliverSlackOnce({key:`frame-upload-review:${slot.anchor_approval_id}`,channel,...content})
      if(!ts) throw new Error('Slack returned no review receipt')
      await requireReceipt('save_frame_upload_review_receipt',{p_id:slot.id,p_token:token,p_channel:channel,p_ts:ts})
      for(const legacy of context.legacy) {
        if(legacy.workspace_id!==slot.workspace_id||legacy.review_slot_id!==slot.id) throw new Error('Legacy review scope mismatch')
        if(legacy.slack_channel_id&&legacy.slack_message_ts) {
          await app.client.chat.update({channel:legacy.slack_channel_id,ts:legacy.slack_message_ts,
            text:'Earlier upload request — use the shared review card.',blocks:[{type:'section',text:{type:'plain_text',text:
              `Earlier upload request. ${legacy.state==='complete'?'Its completed upload is retained.':'Its original record is retained.'} Use the current shared review card in this conversation. Nothing was re-uploaded.`}}]})
          await requireReceipt('close_legacy_frame_upload_notice',{p_slot:slot.id,p_token:token,p_approval:legacy.id,p_ts:legacy.slack_message_ts})
        }
      }
      // Collision controls stay in the original approver's DM, never migrate
      // to a replacement source or the shared producer/CD card.
      const dirtyRows=await Promise.all(context.dirty_approvals.map(r=>r.id===row.id?Promise.resolve(row):getUploadApproval(r.id)))
      for(const outcome of dirtyRows) {
        if(outcome.workspace_id!==slot.workspace_id||outcome.review_slot_id!==slot.id) throw new Error('Outcome review scope mismatch')
        if(outcome.state!=='collision'&&!outcome.collision_message_ts) continue
        if(!outcome.approved_by) throw new Error('Collision approver missing')
        const dm=outcome.collision_channel_id||(await app.client.conversations.open({users:outcome.approved_by})).channel?.id
        if(!dm) throw new Error('Could not open approver DM')
        const content=collisionCard(outcome)
        let collisionTs=outcome.collision_message_ts
        if(collisionTs) await app.client.chat.update({channel:dm,ts:collisionTs,...content})
        else collisionTs=await deliverSlackOnce({key:`frame-upload-collision:${outcome.id}`,channel:dm,...content})
        if(!collisionTs) throw new Error('Slack returned no collision receipt')
        const {error}=await db.from('frame_upload_approvals').update({collision_channel_id:dm,collision_message_ts:collisionTs})
          .eq('id',outcome.id).eq('workspace_id',slot.workspace_id).eq('review_slot_id',slot.id).eq('approved_by',outcome.approved_by)
        if(error) throw new Error('Collision receipt checkpoint failed')
      }
      context.dirty_approvals=context.dirty_approvals.map(r=>r.id===row.id?{id:row.id,updated_at:row.updated_at}:r)
      success=true
    } catch {
      deferred=true
      console.warn('[upload-review] Shared card refresh deferred',snapshot.id)
    } finally {
      if(context) await rpc('finish_frame_upload_review_notice',{p_id:snapshot.id,p_token:token,p_generation:context.slot.generation,p_success:success,p_seen:context.dirty_approvals})
      else {
        // No lease was acquired. Rotate an inaccessible source without hiding
        // it or starving other logical files in the bounded outbox.
        const {error}=await db.from('frame_upload_review_slots').update({updated_at:new Date().toISOString(),
          ...(deferred?{last_error:'Pending source verification unavailable'}:{}),
        }).eq('id',snapshot.id)
        if(error) throw new Error('Upload review deferral checkpoint failed')
      }
    }
  }
}
