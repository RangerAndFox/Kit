import crypto from 'node:crypto'
import type { App } from '@slack/bolt'
import type { KnownBlock, ModalView } from '@slack/types'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { distinctUploadName, uploadReviewers, validateUploadName, type UploadApproval, type UploadSource } from '../../../src/lib/delivery/upload-approval'
import { assertUploadReviewer, getUploadApproval, updateUploadApproval, uploadApprovalsEnabled } from '../../../src/lib/delivery/upload-approval-store'
import { uploadApprovalConflicts, verifyApprovalSource } from './dropbox'
import { deliverSlackOnce } from '../../../src/lib/slack/durable-delivery'

const escape = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

async function authorize(row: UploadApproval, team: string, user: string): Promise<void> {
  const db = createAdminClient()
  const { data: workspace, error: workspaceError } = await db.from('workspaces').select('id').eq('slack_team_id', team).single()
  if (workspaceError || workspace?.id !== row.workspace_id) throw new Error('This upload request belongs to another workspace.')
  await assertUploadReviewer(row, user)
}

function reviewModal(row: UploadApproval): ModalView {
  return {
    type: 'modal', callback_id: 'kit_frame_upload_submit', private_metadata: row.id,
    title: { type: 'plain_text', text: 'Review Frame upload' }, submit: { type: 'plain_text', text: 'Continue' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Source: ${escape(row.source_path)}\nNothing uploads until you confirm. Replace preserves previous versions and their comments.` } },
      { type: 'input', block_id: 'filename', label: { type: 'plain_text', text: 'Client-facing filename' }, element: { type: 'plain_text_input', action_id: 'value', initial_value: row.suggested_name, max_length: 240 } },
      { type: 'input', block_id: 'collision', label: { type: 'plain_text', text: 'If that name already exists in Frame' }, element: { type: 'static_select', action_id: 'value', options: [
        ['replace','Replace — add a version'], ['keep_both','Keep both — use a distinct name'], ['skip','Skip — leave Dropbox untouched'],
      ].map(([value,text]) => ({ text: { type: 'plain_text', text }, value })) } },
      { type: 'input', block_id: 'ready', optional: true, label: { type: 'plain_text', text: 'Render readiness' }, element: { type: 'checkboxes', action_id: 'value', options: [{ text: { type: 'plain_text', text: 'The render/export is finished and ready for review.' }, value: 'yes' }] } },
    ],
  }
}

function card(row: UploadApproval, label: string): { text: string; blocks: KnownBlock[] } {
  const source = row.source_payload as unknown as UploadSource
  const kind = /02_Delivery/i.test(source.subfolder) ? 'Delivery' : 'Client Progress'
  const text = `${kind} — ${label}: ${row.state === 'awaiting' ? 'ready for review' : row.state.replace('_',' ')}`
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(text)}*\n${escape(row.source_path)}\nSuggested name: ${escape(row.approved_name || row.suggested_name)}${row.detail ? `\n${escape(row.detail)}` : ''}` } },
  ]
  if (row.state === 'awaiting') blocks.push({ type: 'actions', elements: [
    { type: 'button', action_id: 'kit_frame_upload_review', value: row.id, text: { type: 'plain_text', text: 'Review & upload' }, style: 'primary' },
    { type: 'button', action_id: 'kit_frame_upload_skip', value: row.id, text: { type: 'plain_text', text: 'Skip' } },
  ] })
  return { text, blocks }
}

/** Bounded outbox drain on the existing Railway inbox sweep. The shared Slack
 * receipt ledger refuses to repost when an earlier outcome is unknown. */
export async function syncUploadApprovalNotices(app: App): Promise<void> {
  if (!uploadApprovalsEnabled()) return
  const db = createAdminClient()
  const { data: rows, error } = await db.from('frame_upload_approvals').select('*').eq('notice_dirty', true).order('updated_at').limit(10)
  if (error) throw error
  for (const row of rows || []) {
    const token = crypto.randomUUID()
    const { data: claimed, error: claimError } = await db.rpc('claim_frame_upload_notice', { p_id: row.id, p_token: token })
    if (claimError) throw claimError
    if (!claimed) continue
    try {
      const { data: project, error: projectError } = await db.from('projects').select('project_manager_slack_id,external_ids,project_code,name').eq('id', row.project_id).eq('workspace_id', row.workspace_id).single()
      if (projectError || !project) throw new Error('Upload reviewer project unavailable')
      const users = uploadReviewers(project)
      if (!users.length) throw new Error('Project has no assigned producer/CD; upload remains blocked')
      let channel = row.slack_channel_id
      if (!channel) {
        channel = (await app.client.conversations.open({ users: users.join(',') })).channel?.id || null
        if (!channel) throw new Error('Could not open private upload review')
        const { error: channelError } = await db.from('frame_upload_approvals').update({ slack_channel_id: channel }).eq('id', row.id).eq('notice_token', token)
        if (channelError) throw channelError
      }
      const content = card(row, `${project.project_code} — ${project.name}`)
      let ts = row.slack_message_ts
      if (ts) await app.client.chat.update({ channel, ts, ...content })
      else ts = await deliverSlackOnce({ key: `frame-upload-review:${row.id}`, channel, ...content })
      if (!ts) throw new Error('Slack did not return a review receipt')
      const { error: savedError } = await db.from('frame_upload_approvals').update({ slack_message_ts: ts })
        .eq('id', row.id).eq('notice_token', token)
      if (savedError) throw savedError
      // A concurrent approval may have dirtied the card after our snapshot.
      const { error: ackError } = await db.from('frame_upload_approvals').update({ notice_dirty: false })
        .eq('id', row.id).eq('notice_token', token).eq('updated_at', row.updated_at)
      if (ackError) throw ackError
    } finally {
      const { error: releaseError } = await db.from('frame_upload_approvals').update({ notice_token: null })
        .eq('id', row.id).eq('notice_token', token)
      if (releaseError) throw releaseError
    }
  }
}

export function registerUploadApprovalHandlers(app: App): void {
  app.action(/kit_frame_upload_(review|skip)/, async ({ ack, body, action, client }) => {
    await ack()
    let openedView: string | undefined
    try {
      if (!('value' in action) || !action.value || !('trigger_id' in body)) return
      const skipping = 'action_id' in action && action.action_id === 'kit_frame_upload_skip'
      if (!skipping) {
        openedView = (await client.views.open({ trigger_id: body.trigger_id, view: {
          type: 'modal', title: { type: 'plain_text', text: 'Upload review' }, close: { type: 'plain_text', text: 'Close' },
          blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Loading the request and checking your project access…' } }],
        } })).view?.id
        if (!openedView) throw new Error('Slack did not open the review form.')
      }
      const row = await getUploadApproval(action.value)
      await authorize(row, body.team?.id || '', body.user.id)
      if (row.state !== 'awaiting') throw new Error('This request has already been decided or superseded.')
      if (skipping) {
        const { data, error } = await createAdminClient().rpc('decide_frame_upload', { p_id: row.id, p_workspace: row.workspace_id, p_actor: body.user.id, p_name: '', p_decision: 'skip' })
        if (error) throw error
        if (!data) throw new Error('Already decided or superseded.')
      } else await client.views.update({ view_id: openedView!, view: reviewModal(row) })
    } catch (error) {
      const text = `Upload review: ${error instanceof Error ? error.message : 'Could not open request.'}`
      if (openedView) await client.views.update({ view_id: openedView, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text } }],
      } })
      else await client.chat.postMessage({ channel: body.user.id, text })
    }
  })
  app.view('kit_frame_upload_submit', async ({ ack, body, view, client }) => {
    // Provider reads cannot fit reliably inside Slack's 3-second ack window.
    // Show a loading modal immediately, then a final exact-name confirmation.
    await ack({ response_action: 'update', view: {
      type: 'modal', title: { type: 'plain_text', text: 'Checking upload' }, close: { type: 'plain_text', text: 'Close' },
      blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Checking the source and Frame destination. Nothing has changed yet.' } }],
    } })
    try {
      const row = await getUploadApproval(view.private_metadata)
      await authorize(row, body.team?.id || '', body.user.id)
      if (row.state !== 'awaiting') throw new Error('This request has already been decided or superseded.')
      let name = view.state.values.filename?.value?.value || ''
      let decision = view.state.values.collision?.value?.selected_option?.value || ''
      if (!['replace','keep_both','skip'].includes(decision)) throw new Error('Choose what to do if the name exists.')
      let conflict: { id: string; type: string } | undefined
      if (decision !== 'skip') {
        const invalid = validateUploadName(name, row.source_path)
        if (invalid) throw new Error(invalid)
        if (!view.state.values.ready?.value?.selected_options?.length) throw new Error('Confirm the render/export is finished before uploading.')
        if (!await verifyApprovalSource(row)) {
          await updateUploadApproval(row.id, { state: 'superseded', detail: 'The Dropbox source changed. Review the new revision instead.' })
          throw new Error('The Dropbox source changed. This approval is no longer valid.')
        }
        const children = await uploadApprovalConflicts(row.project_id, row.source_payload as unknown as UploadSource)
        const matches = children.filter(c => c.name.toLowerCase() === name.toLowerCase())
        if (!matches.length) decision = 'new'
        else if (decision === 'keep_both') name = distinctUploadName(name, children.map(c => c.name))
        else {
          if (matches.length !== 1 || !['file','version_stack'].includes(matches[0].type)) throw new Error('The destination has ambiguous same-name items. Choose a different name.')
          conflict = matches[0]
        }
      }
      await client.views.update({ view_id: view.id, view: {
        type: 'modal', callback_id: 'kit_frame_upload_confirm', private_metadata: JSON.stringify({ id: row.id, name, decision, conflict }),
        title: { type: 'plain_text', text: 'Confirm upload' }, submit: { type: 'plain_text', text: decision === 'skip' ? 'Skip' : 'Upload to Frame' }, close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: decision === 'skip' ? 'Leave Dropbox untouched. Do not upload this revision.' : `Rename in Dropbox and upload as:\n${name}\n\n${decision === 'replace' ? 'Add a version, preserving the existing file and comments.' : 'Create a new file in the mirrored Frame folder.'}` } }],
      } })
    } catch (error) {
      await client.views.update({ view_id: view.id, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review needed' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: `${error instanceof Error ? error.message : 'Could not check upload.'}\nClose and reopen Review & upload to make corrections.` } }],
      } })
    }
  })
  app.view('kit_frame_upload_confirm', async ({ ack, body, view, client }) => {
    await ack()
    try {
      const input = JSON.parse(view.private_metadata) as { id: string; name: string; decision: string; conflict?: { id: string; type: string } }
      const row = await getUploadApproval(input.id)
      await authorize(row, body.team?.id || '', body.user.id)
      if (input.decision !== 'skip') {
        const invalid = validateUploadName(input.name, row.source_path)
        if (invalid) throw new Error(invalid)
        if (!await verifyApprovalSource(row)) throw new Error('The Dropbox source changed. Reopen the latest request.')
      }
      const { data, error } = await createAdminClient().rpc('decide_frame_upload', {
        p_id: row.id, p_workspace: row.workspace_id, p_actor: body.user.id, p_name: input.name, p_decision: input.decision,
        p_conflict_id: input.conflict?.id, p_conflict_type: input.conflict?.type,
      })
      if (error) throw new Error('Could not reserve this upload. Another upload may already be using that name; reopen the review.')
      if (!data) throw new Error('Already decided or superseded. No second upload was queued.')
    } catch (error) {
      await client.chat.postMessage({ channel: body.user.id, text: `Upload review: ${error instanceof Error ? error.message : 'Could not confirm upload.'}` })
    }
  })
}
