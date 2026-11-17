import { distinctUploadName, extension, suggestedUploadName, validateUploadName, type UploadApproval } from './upload-approval'

export const folderUploadsEnabled = () => process.env.FRAMEIO_FOLDER_UPLOADS_ENABLED !== 'false'
export type UploadFolder = {
  id: string; workspace_id: string; project_id: string; folder_path: string; generation: number
  manifest: Array<{ id: string; version: number }>; slack_channel_id: string | null; slack_message_ts: string | null
}
export type FolderSlot = { id: string; slack_channel_id: string | null; slack_message_ts: string | null; folder_notice_closed: boolean }
export type FolderContext = {
  folder: UploadFolder; files: UploadApproval[]; slots: FolderSlot[]
  dirty: Array<{ id: string; updated_at: string }>; legacy: UploadApproval[]
}
export type FolderName = { id: string; name: string }

/** One dated/review folder under outgoing, including its video/accessibility children. */
export function uploadFolderPath(path: string): string {
  if (!/^\/production\/\d{4}\/[^/]+\/09_outgoing\/(01_client progress|02_delivery)\/[^/]+/i.test(path)) throw new Error('Unknown outgoing folder.')
  const parts = path.toLowerCase().split('/')
  return parts.slice(0, Math.min(parts.length - 1, 7)).join('/')
}
export function folderDropboxUrl(path: string): string {
  return `https://www.dropbox.com/home${('/Ranger & Fox' + path).split('/').map(encodeURIComponent).join('/')}`
}
export function uploadDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find(p => p.type === type)?.value || ''
  return `${part('month')}${part('day')}${part('year')}`
}
export function folderSuggestedBase(client: string, project: string, folder: string): string {
  const base = suggestedUploadName(client, project, 'upload.mp4').replace(/\.mp4$/i, '')
  if (/\/02_delivery(?:\/|$)/i.test(folder)) return base
  const phase = /(?:^|[_\s-])(anim(?:ation)?|edit|storyboard|boards?|styleframes?|design|final)(?:[_\s-]*([rv]\d+))?(?=[_\s.-]|$)/i.exec(folder.split('/').pop() || '')
  return base + (phase ? `_${[phase[1], phase[2]].filter(Boolean).join('_')}` : '')
}
export function folderNames(context: FolderContext, base: string, date: string): FolderName[] {
  if (!/^\d{6}$/.test(date)) throw new Error('Invalid upload date.')
  const pending = context.files.filter(f => f.state === 'awaiting').sort((a, b) => a.source_path.localeCompare(b.source_path) || a.id.localeCompare(b.id))
  if (!pending.length || pending.length > 100) throw new Error('This folder changed or exceeds the 100-file review limit. Reopen its latest card.')
  const occupied = new Map<string, string[]>()
  return pending.map(row => {
    const ext = extension(row.source_path)
    const technical = /\/02_delivery(?:\/|$)/i.test(context.folder.folder_path)
    const suffix = technical ? `_${ext.slice(1).toUpperCase()}` : ''
    const initial = `${base}${suffix}_${date}${ext}`
    const invalid = validateUploadName(initial, row.source_path)
    if (invalid) throw new Error(invalid)
    const parent = row.source_path.slice(0, row.source_path.lastIndexOf('/')).toLowerCase()
    const used = occupied.get(parent) || []
    const name = used.some(n => n.toLowerCase() === initial.toLowerCase()) ? distinctUploadName(initial, used) : initial
    used.push(name); occupied.set(parent, used)
    return { id: row.id, name }
  })
}
