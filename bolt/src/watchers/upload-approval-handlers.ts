import type { App } from '@slack/bolt'
import type { ModalView } from '@slack/types'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { validateUploadName, type UploadApproval, type UploadSource } from '../../../src/lib/delivery/upload-approval'
import { assertUploadReviewer, getUploadApproval } from '../../../src/lib/delivery/upload-approval-store'
import { uploadApprovalConflicts, verifyApprovalSource } from './dropbox'
import { decidedUploadMessage } from './upload-approval-card'
import { assertCollisionOwner, collisionChoices, collisionModal, type CollisionChoice } from './upload-collision'
import { syncUploadApprovalNotices } from './upload-review-notices'
import { uploadReviewDiagnostic } from './upload-review-diagnostics'

const escape = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

async function authorize(row: UploadApproval, team: string, user: string): Promise<void> {
  const db = createAdminClient()
  const { data: workspace, error: workspaceError } = await db.from('workspaces').select('id').eq('slack_team_id', team).single()
  if (workspaceError || workspace?.id !== row.workspace_id) throw new Error('This upload request belongs to another workspace.')
  await assertUploadReviewer(row, user)
}

export function reviewModal(row: UploadApproval, name = row.suggested_name.replace(/_Phase_Version(?=\.[a-z0-9]{1,8}$)/i, ''), correction?: string): ModalView {
  return {
    type: 'modal', callback_id: 'kit_frame_upload_submit', private_metadata: row.id,
    title: { type: 'plain_text', text: 'Review Frame upload' }, submit: { type: 'plain_text', text: 'Upload' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Source: ${escape(row.source_path)}\nNothing uploads until you confirm. If Frame already has that filename, Kit will ask you what to do.` } },
      ...(correction ? [{ type: 'section' as const, text: { type: 'plain_text' as const, text: correction } }] : []),
      { type: 'input', block_id: 'filename', label: { type: 'plain_text', text: 'Client-facing filename' }, hint: { type: 'plain_text', text: 'Edit the suggested name if needed. Phase/version is optional; keep the extension. Kit checks file readiness automatically.' }, element: { type: 'plain_text_input', action_id: 'value', initial_value: name, max_length: 240 } },
    ],
  }
}

export { syncUploadApprovalNotices } from './upload-review-notices'

async function refreshDecisionCard(app: App, id: string): Promise<void> {
  try { await syncUploadApprovalNotices(app, id) }
  catch { console.warn('[upload-review] Card refresh deferred to durable outbox') }
}

function confirmationModal(row: UploadApproval, choice: CollisionChoice, collisionVersion?: number): ModalView {
  const source = row.source_payload as unknown as UploadSource
  const parent = typeof source.name === 'string' ? source.name.split('/').slice(0, -1).join(' / ') : ''
  const destination = [source.safeName, '03_Outgoing', source.subfolder, parent].filter(Boolean).join(' / ')
  return {
    type: 'modal', callback_id: 'kit_frame_upload_confirm', private_metadata: JSON.stringify({ id: row.id, ...choice, collisionVersion }),
    title: { type: 'plain_text', text: 'Confirm upload' }, submit: { type: 'plain_text', text: choice.decision === 'skip' ? 'Skip' : 'Confirm' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: choice.decision === 'skip' ? 'Leave Dropbox and Frame untouched. Do not upload this revision.' : `Upload this file to Frame?\n\nFilename: ${choice.name}\nFrame folder: ${destination}\n\n${choice.decision === 'replace' ? 'Add a version, preserving the existing file and comments.' : 'Kit checks the destination before renaming or uploading. If a matching filename is found, only you will be asked what to do.'}` } },
      ...(collisionVersion === undefined ? [{ type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'kit_frame_upload_back', text: { type: 'plain_text' as const, text: 'Go back' } }] }] : []),
    ],
  }
}

export function registerUploadApprovalHandlers(app: App): void {
  app.action(/kit_frame_upload_(review|skip)/, async ({ ack, body, action, client }) => {
    const diagnostic = { action: 'action_id' in action ? action.action_id : undefined,
      request: 'value' in action ? action.value : undefined, actor: body.user.id }
    uploadReviewDiagnostic('handler_received', diagnostic)
    let openedView: string | undefined
    let stage = 'ack'
    try {
      await ack()
      if (!('value' in action) || !action.value || !('trigger_id' in body)) {
        stage = 'invalid_action'
        throw new Error('This button is missing its review context. Please reopen the original request.')
      }
      const skipping = 'action_id' in action && action.action_id === 'kit_frame_upload_skip'
      if (!skipping) {
        stage = 'open_form'
        openedView = (await client.views.open({ trigger_id: body.trigger_id, view: {
          type: 'modal', title: { type: 'plain_text', text: 'Upload review' }, close: { type: 'plain_text', text: 'Close' },
          blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Loading the request and checking your project access…' } }],
        } })).view?.id
        if (!openedView) throw new Error('Slack did not open the review form.')
        uploadReviewDiagnostic('loading_form_opened', diagnostic)
      }
      stage = 'authorize'
      const row = await getUploadApproval(action.value)
      await authorize(row, body.team?.id || '', body.user.id)
      if (row.state !== 'awaiting') throw new Error(decidedUploadMessage(row))
      if (skipping) {
        const { data, error } = await createAdminClient().rpc('decide_frame_upload', { p_id: row.id, p_workspace: row.workspace_id, p_actor: body.user.id, p_name: '', p_decision: 'skip' })
        if (error) throw error
        if (!data) throw new Error(decidedUploadMessage(await getUploadApproval(row.id)))
        await refreshDecisionCard(app, row.id)
      } else {
        stage = 'populate_form'
        await client.views.update({ view_id: openedView!, view: reviewModal(row) })
        uploadReviewDiagnostic('review_form_ready', diagnostic)
      }
    } catch (error) {
      uploadReviewDiagnostic(`${stage}_failed`, { ...diagnostic, error })
      const text = `Upload review: ${error instanceof Error ? error.message : 'Could not open request.'}`
      try {
        if (openedView) await client.views.update({ view_id: openedView, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text } }],
        } })
        else await client.chat.postMessage({ channel: body.user.id, text })
      } catch (feedbackError) {
        uploadReviewDiagnostic('error_feedback_failed', { ...diagnostic, error: feedbackError })
      }
    }
  })
  app.view('kit_frame_upload_submit', async ({ ack, body, view, client }) => {
    // Provider reads cannot fit reliably inside Slack's 3-second ack window.
    // Show a loading modal immediately, then a final exact-name confirmation.
    await ack({ response_action: 'update', view: {
      type: 'modal', title: { type: 'plain_text', text: 'Checking upload' }, close: { type: 'plain_text', text: 'Close' },
      blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Checking the source. Nothing has changed yet.' } }],
    } })
    try {
      const row = await getUploadApproval(view.private_metadata)
      await authorize(row, body.team?.id || '', body.user.id)
      if (row.state !== 'awaiting') throw new Error(decidedUploadMessage(row))
      const name = view.state.values.filename?.value?.value || ''
      const invalid = validateUploadName(name, row.source_path)
      if (invalid) {
        await client.views.update({ view_id: view.id, view: reviewModal(row, name, invalid) })
        return
      }
      if (!await verifyApprovalSource(row)) {
        // A second review may finish this read after the first has approved.
        // Never overwrite the winning decision from a stale form.
        const { error } = await createAdminClient().from('frame_upload_approvals').update({
          state: 'superseded', detail: 'The Dropbox source changed. Review the new revision instead.',
          notice_dirty: true, updated_at: new Date().toISOString(),
        }).eq('id', row.id).eq('state', 'awaiting').eq('approval_version', row.approval_version)
        if (error) throw error
        throw new Error('The Dropbox source changed. This approval is no longer valid.')
      }
      await client.views.update({ view_id: view.id, view: confirmationModal(row, { name, decision: 'new' }) })
    } catch (error) {
      await client.views.update({ view_id: view.id, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: error instanceof Error ? error.message : 'Could not check upload.' } }],
      } })
    }
  })
  app.action('kit_frame_upload_back', async ({ ack, body, client }) => {
    await ack()
    if (!('view' in body) || !body.view) return
    const view = body.view
    try {
      const input = JSON.parse(view.private_metadata || '') as CollisionChoice & { id: string; collisionVersion?: number }
      const row = await getUploadApproval(input.id)
      await authorize(row, body.team?.id || '', body.user.id)
      if (row.state !== 'awaiting') throw new Error(decidedUploadMessage(row))
      if (input.collisionVersion !== undefined || input.decision !== 'new' || typeof input.name !== 'string') throw new Error('Open the latest upload review.')
      await client.views.update({ view_id: view.id, view: reviewModal(row, input.name) })
    } catch (error) {
      await client.views.update({ view_id: view.id, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: error instanceof Error ? error.message : 'Could not reopen upload review.' } }],
      } })
    }
  })
  app.action('kit_frame_collision_review', async ({ ack, body, action, client }) => {
    await ack()
    let viewId: string | undefined
    try {
      if (!('value' in action) || !action.value || !('trigger_id' in body)) return
      viewId = (await client.views.open({ trigger_id: body.trigger_id, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Checking duplicate' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Checking the current destination. Nothing has changed yet.' } }],
      } })).view?.id
      if (!viewId) throw new Error('Slack did not open the duplicate review.')
      const row = await getUploadApproval(action.value)
      await authorize(row, body.team?.id || '', body.user.id)
      assertCollisionOwner(row, body.user.id)
      const children = await uploadApprovalConflicts(row.project_id, row.source_payload as unknown as UploadSource)
      await client.views.update({ view_id: viewId, view: collisionModal(row, children) })
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not check the duplicate.'
      if (viewId) await client.views.update({ view_id: viewId, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text } }],
      } })
      else await client.chat.postMessage({ channel: body.user.id, text })
    }
  })
  app.view('kit_frame_collision_choose', async ({ ack, body, view, client }) => {
    await ack({ response_action: 'update', view: {
      type: 'modal', title: { type: 'plain_text', text: 'Checking decision' }, close: { type: 'plain_text', text: 'Close' },
      blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Checking the exact filename before confirmation…' } }],
    } })
    try {
      const input = JSON.parse(view.private_metadata) as { id: string; version: number }
      const row = await getUploadApproval(input.id)
      await authorize(row, body.team?.id || '', body.user.id)
      assertCollisionOwner(row, body.user.id, input.version)
      const decision = view.state.values.collision?.value?.selected_option?.value
      let choice: CollisionChoice | undefined
      if (decision === 'skip') choice = { decision, name: row.approved_name || '' }
      else {
        if (!await verifyApprovalSource(row)) throw new Error('The Dropbox source changed. Review the new revision instead.')
        const children = await uploadApprovalConflicts(row.project_id, row.source_payload as unknown as UploadSource)
        choice = collisionChoices(row, children).find(c => c.decision === decision)
      }
      if (!choice) throw new Error('The destination changed. Reopen Resolve duplicate to check the latest choices.')
      await client.views.update({ view_id: view.id, view: confirmationModal(row, choice, input.version) })
    } catch (error) {
      await client.views.update({ view_id: view.id, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: error instanceof Error ? error.message : 'Could not check this decision.' } }],
      } })
    }
  })
  app.view('kit_frame_upload_confirm', async ({ ack, body, view, client }) => {
    await ack()
    try {
      const input = JSON.parse(view.private_metadata) as CollisionChoice & { id: string; collisionVersion?: number }
      const row = await getUploadApproval(input.id)
      await authorize(row, body.team?.id || '', body.user.id)
      if (input.collisionVersion !== undefined) assertCollisionOwner(row, body.user.id, input.collisionVersion)
      else {
        if (row.state !== 'awaiting') throw new Error(decidedUploadMessage(row))
        if (input.decision !== 'new') throw new Error('This form is outdated. Reopen Review & upload; duplicate decisions are now requested after approval.')
      }
      if (input.decision !== 'skip') {
        const invalid = validateUploadName(input.name, row.source_path)
        if (invalid) throw new Error(invalid)
        if (!await verifyApprovalSource(row)) throw new Error('The Dropbox source changed. Reopen the latest request.')
      }
      const args = {
        p_id: row.id, p_workspace: row.workspace_id, p_actor: body.user.id, p_name: input.name, p_decision: input.decision,
        p_conflict_id: input.conflict?.id, p_conflict_type: input.conflict?.type,
      }
      const db = createAdminClient()
      const { data, error } = input.collisionVersion !== undefined
        ? await db.rpc('resolve_frame_upload_collision', { ...args, p_version: input.collisionVersion })
        : await db.rpc('decide_frame_upload', args)
      if (error) throw new Error('Could not reserve this upload. Another upload may already be using that name; reopen the review.')
      if (!data) throw new Error(decidedUploadMessage(await getUploadApproval(row.id)))
      await refreshDecisionCard(app, row.id)
    } catch (error) {
      await client.chat.postMessage({ channel: body.user.id, text: `Upload review: ${error instanceof Error ? error.message : 'Could not confirm upload.'}` })
    }
  })
}
