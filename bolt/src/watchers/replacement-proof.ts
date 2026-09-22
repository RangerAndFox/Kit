/** A replacement is not proved by a filename or by an upload being accepted. */
export type ReplacementTransfer = {
  id: string
  project_id: string
  frameio_project_id: string
  frameio_folder_id: string
  frameio_file_id: string
  created_at: string
  state: string
}

export function provesReadyReplacement(input: {
  original: ReplacementTransfer
  replacement: ReplacementTransfer
  sourceId: string
  replacementSourceId: string
  replacementRev: string
  currentSource: { id?: string; rev?: string; size?: number }
  originalSourceMissing: boolean
  originalFrameMissing: boolean
  replacementFile: { id?: string; status?: string; file_size?: number; parent_id?: string }
}): boolean {
  const { original: a, replacement: b, currentSource: source, replacementFile: file } = input
  return Boolean(
    input.originalSourceMissing && input.originalFrameMissing &&
    input.sourceId && input.replacementSourceId && input.sourceId !== input.replacementSourceId &&
    input.replacementRev && source.id === input.replacementSourceId && source.rev === input.replacementRev &&
    a.project_id && a.project_id === b.project_id &&
    a.frameio_project_id && a.frameio_project_id === b.frameio_project_id &&
    a.frameio_folder_id && a.frameio_folder_id === b.frameio_folder_id &&
    a.frameio_file_id && a.frameio_file_id !== b.frameio_file_id &&
    Date.parse(b.created_at) > Date.parse(a.created_at) && b.state === 'ready' &&
    file.id === b.frameio_file_id && file.parent_id === b.frameio_folder_id &&
    ['ready', 'complete', 'completed', 'processed', 'transcoded'].includes(file.status || '') &&
    typeof source.size === 'number' && source.size > 0 && source.size === file.file_size,
  )
}
