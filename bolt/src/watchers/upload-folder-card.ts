import type { KnownBlock } from '@slack/types'
import { folderDropboxUrl, folderNames, type FolderContext } from '../../../src/lib/delivery/upload-folder'

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export function uploadFolderCard(context: FolderContext, label: string, base: string, date: string): { text: string; blocks: KnownBlock[] } {
  const { folder, files } = context
  const pending = files.filter(f => f.state === 'awaiting')
  const active = files.filter(f => ['approved', 'uploading'].includes(f.state)).length
  const collisions = files.filter(f => f.state === 'collision').length
  const complete = files.filter(f => f.state === 'complete').length
  const text = pending.length ? `Files were added to Dropbox — ${label}` : `Folder upload — ${label}: ${active ? 'uploading' : collisions ? 'duplicate review needed' : 'review complete'}`
  const lines = [`*${escape(label)}*`, `Files were added to <${folderDropboxUrl(folder.folder_path)}|Dropbox>.`]
  if (pending.length) {
    lines.push(`${pending.length} file${pending.length === 1 ? '' : 's'} ready for review.`)
    const type = /\/02_delivery(?:\/|$)/.test(folder.folder_path) ? '[format]' : '[phase in editable name]'
    lines.push(`Naming: \`${escape(base)}${type === '[format]' ? '_[format]' : ''}_${date}.[extension]\``)
  }
  if (active || collisions || complete) lines.push(`${active} uploading · ${collisions} awaiting duplicate decision · ${complete} complete`)
  const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }]
  if (pending.length) blocks.push({ type: 'actions', elements: [
    { type: 'button', action_id: 'kit_frame_folder_review', value: JSON.stringify({ id: folder.id, generation: folder.generation }), text: { type: 'plain_text', text: 'UPLOAD TO FRAME' }, style: 'primary' },
    { type: 'button', action_id: 'kit_frame_folder_cancel', value: JSON.stringify({ id: folder.id, generation: folder.generation }), text: { type: 'plain_text', text: 'CANCEL UPLOAD' } },
  ] })
  return { text, blocks }
}
export function folderNamePreview(context: FolderContext, base: string, date: string): string {
  const names = folderNames(context, base, date)
  return names.slice(0, 12).map(n => n.name).join('\n') + (names.length > 12 ? `\n…and ${names.length - 12} more files` : '')
}
