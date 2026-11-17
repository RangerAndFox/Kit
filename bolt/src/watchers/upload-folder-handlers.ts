import type { App } from '@slack/bolt'
import type { ModalView } from '@slack/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { assertUploadReviewer } from '../../../src/lib/delivery/upload-approval-store'
import { folderNames, folderSuggestedBase, folderUploadsEnabled, uploadDate, type FolderContext } from '../../../src/lib/delivery/upload-folder'
import { folderRpc, prepareUploadFolder } from '../../../src/lib/delivery/upload-folder-store'
import { verifyApprovalSource } from './dropbox'
import { folderNamePreview } from './upload-folder-card'
import { syncUploadFolderNotices } from './upload-folder-notices'
import { uploadReviewDiagnostic } from './upload-review-diagnostics'

type Input = { id: string; generation: number; base?: string; date?: string; cancel?: boolean }
const simpleView = (title: string, text: string): ModalView => ({ type: 'modal', title: { type: 'plain_text', text: title }, close: { type: 'plain_text', text: 'Close' }, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] })

async function authorized(input: Input, team: string, user: string): Promise<FolderContext> {
  if (!folderUploadsEnabled()) throw new Error('Folder review is unavailable.')
  const db = createAdminClient() as unknown as SupabaseClient
  const { data: folder, error } = await db.from('frame_upload_folder_reviews').select('id,workspace_id,project_id,folder_path').eq('id', input.id).single()
  const { data: workspace, error: workspaceError } = await db.from('workspaces').select('id').eq('slack_team_id', team).single()
  if (error || workspaceError || !folder || folder.workspace_id !== workspace?.id) throw new Error('Folder request unavailable in this workspace.')
  await assertUploadReviewer(folder, user)
  const context = await prepareUploadFolder(folder.project_id, folder.folder_path)
  if (context.folder.generation !== input.generation || !context.files.some(f => f.state === 'awaiting')) {
    throw new Error('This folder changed or another reviewer already decided it. Open the latest folder card. Nothing new was approved.')
  }
  return context
}
export function folderReviewModal(context: FolderContext, base: string, date: string): ModalView {
  return {
    type: 'modal', callback_id: 'kit_frame_folder_preview', private_metadata: JSON.stringify({ id: context.folder.id, generation: context.folder.generation, date }),
    title: { type: 'plain_text', text: 'Upload folder to Frame' }, submit: { type: 'plain_text', text: 'Continue' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: `${context.files.filter(f => f.state === 'awaiting').length} files · same Dropbox folder structure in Frame` } },
      { type: 'input', block_id: 'folder_name', label: { type: 'plain_text', text: 'Client-facing name' }, element: { type: 'plain_text_input', action_id: 'value', initial_value: base, max_length: 180 }, hint: { type: 'plain_text', text: 'Edit this prefix. Kit adds the date, file format for Delivery, and each original extension.' } },
    ],
  }
}
function confirmation(context: FolderContext, input: Input): ModalView {
  const view = simpleView(input.cancel ? 'Cancel folder upload' : 'Confirm folder upload', input.cancel
    ? `Cancel the ${context.files.filter(f => f.state === 'awaiting').length} pending files? Dropbox and Frame stay unchanged. Already-uploaded files are retained.`
    : `${folderNamePreview(context, input.base || '', input.date || '')}\n\nTo Frame: ${context.folder.folder_path.replace('/09_outgoing/', '/03_Outgoing/')}\n\nConfirm only when these files have finished rendering. Matching Frame filenames will ask you to Replace, Keep both, or Skip.`)
  return { ...view, callback_id: 'kit_frame_folder_confirm', private_metadata: JSON.stringify(input), submit: { type: 'plain_text', text: input.cancel ? 'CANCEL UPLOAD' : 'Confirm upload' },
    blocks: [...view.blocks, ...(!input.cancel ? [{ type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'kit_frame_folder_back', text: { type: 'plain_text' as const, text: 'Go back' } }] }] : [])] }
}

export function registerUploadFolderHandlers(app: App): void {
  app.action(/kit_frame_folder_(review|cancel)/, async ({ ack, body, action, client }) => {
    await ack()
    let viewId: string | undefined
    try {
      if (!('value' in action) || !action.value || !('trigger_id' in body)) throw new Error('Reopen the latest folder request.')
      viewId = (await client.views.open({ trigger_id: body.trigger_id, view: simpleView('Folder upload', 'Loading folder…') })).view?.id
      if (!viewId) throw new Error('Slack could not open the folder review.')
      const input = JSON.parse(action.value) as Input
      const context = await authorized(input, body.team?.id || '', body.user.id)
      if ('action_id' in action && action.action_id === 'kit_frame_folder_cancel') {
        await client.views.update({ view_id: viewId, view: confirmation(context, { ...input, cancel: true }) })
      } else {
        const { data: project, error } = await createAdminClient().from('projects').select('client,name').eq('id', context.folder.project_id).eq('workspace_id', context.folder.workspace_id).single()
        if (error || !project) throw new Error('Project name unavailable.')
        await client.views.update({ view_id: viewId, view: folderReviewModal(context, folderSuggestedBase(project.client, project.name, context.folder.folder_path), uploadDate()) })
      }
    } catch (error) {
      uploadReviewDiagnostic('folder_form_failed', { actor: body.user.id, error })
      const text = error instanceof Error ? error.message : 'Could not open folder review.'
      if (viewId) await client.views.update({ view_id: viewId, view: simpleView('Review needed', text) })
      else await client.chat.postMessage({ channel: body.user.id, text: `Folder upload: ${text}` })
    }
  })
  app.view('kit_frame_folder_preview', async ({ ack, body, view, client }) => {
    await ack({ response_action: 'update', view: simpleView('Folder upload', 'Preparing filenames…') })
    try {
      const input = JSON.parse(view.private_metadata) as Input
      const context = await authorized(input, body.team?.id || '', body.user.id)
      input.base = view.state.values.folder_name?.value?.value || ''
      await client.views.update({ view_id: view.id, view: confirmation(context, input) })
    } catch (error) {
      await client.views.update({ view_id: view.id, view: simpleView('Review needed', error instanceof Error ? error.message : 'Could not prepare filenames.') })
    }
  })
  app.action('kit_frame_folder_back', async ({ ack, body, client }) => {
    await ack()
    if (!('view' in body) || !body.view) return
    try {
      const input = JSON.parse(body.view.private_metadata || '') as Input
      const context = await authorized(input, body.team?.id || '', body.user.id)
      await client.views.update({ view_id: body.view.id, view: folderReviewModal(context, input.base || '', input.date || uploadDate()) })
    } catch (error) {
      await client.views.update({ view_id: body.view.id, view: simpleView('Review needed', error instanceof Error ? error.message : 'Folder changed.') })
    }
  })
  app.view('kit_frame_folder_confirm', async ({ ack, body, view, client }) => {
    await ack({ response_action: 'update', view: simpleView('Folder upload', 'Checking files and reserving your decision…') })
    try {
      const input = JSON.parse(view.private_metadata) as Input
      const context = await authorized(input, body.team?.id || '', body.user.id)
      const names = input.cancel ? [] : folderNames(context, input.base || '', input.date || '')
      if (!input.cancel) {
        const files = context.files.filter(f => f.state === 'awaiting')
        for (let start = 0; start < files.length; start += 4) {
          const verified = await Promise.all(files.slice(start, start + 4).map(async row => {
            try { return await verifyApprovalSource(row) } catch { return false }
          }))
          if (verified.some(ok => !ok)) throw new Error('A Dropbox file moved or changed. Open the latest folder request; nothing new was approved.')
        }
      }
      const won = await folderRpc<boolean>('decide_frame_upload_folder', {
        p_id: context.folder.id, p_workspace: context.folder.workspace_id, p_actor: body.user.id,
        p_generation: input.generation, p_names: names, p_cancel: input.cancel === true,
      })
      if (!won) throw new Error('Another reviewer decided this folder, or its files changed. Nothing new was approved by this submission.')
      await client.views.update({ view_id: view.id, view: simpleView(input.cancel ? 'Upload cancelled' : 'Upload queued', input.cancel
        ? 'Pending files were skipped. Dropbox and Frame are unchanged.'
        : `${names.length} files approved. Kit will upload them and ask you privately about any matching Frame filenames.`) })
      try { await syncUploadFolderNotices(app, context.files.find(f => f.state === 'awaiting')?.id) }
      catch { console.warn('[upload-folder] Decision card refresh deferred') }
    } catch (error) {
      await client.views.update({ view_id: view.id, view: simpleView('Review needed', error instanceof Error ? error.message : 'Could not confirm folder upload.') })
    }
  })
}
