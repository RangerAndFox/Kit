import { describe, expect, it } from 'vitest'
import { provesReadyReplacement } from '../src/watchers/replacement-proof'

function proof() {
  return {
    original: { id: 'old', project_id: 'project', frameio_project_id: 'frame-project',
      frameio_folder_id: 'folder', frameio_file_id: 'old-file', created_at: '2026-09-21T15:08:54Z', state: 'processing' },
    replacement: { id: 'new', project_id: 'project', frameio_project_id: 'frame-project',
      frameio_folder_id: 'folder', frameio_file_id: 'new-file', created_at: '2026-09-21T16:10:47Z', state: 'ready' },
    sourceId: 'id:old', replacementSourceId: 'id:new', replacementRev: 'new-rev',
    currentSource: { id: 'id:new', rev: 'new-rev', size: 131037032 },
    originalSourceMissing: true, originalFrameMissing: true,
    replacementFile: { id: 'new-file', status: 'transcoded', file_size: 131037032, parent_id: 'folder' },
  }
}

describe('deleted upload replacement proof', () => {
  it('accepts a later completed replacement with live identity, readiness and size proof', () => {
    expect(provesReadyReplacement(proof())).toBe(true)
  })
  it.each(['project_id', 'frameio_project_id', 'frameio_folder_id'] as const)('rejects another %s', (key) => {
    const input = proof(); input.replacement[key] = 'another'
    expect(provesReadyReplacement(input)).toBe(false)
  })
  it.each(['originalSourceMissing', 'originalFrameMissing'] as const)('requires %s', (key) => {
    const input = proof(); input[key] = false
    expect(provesReadyReplacement(input)).toBe(false)
  })
  it.each(['processing', 'uploaded', 'failed', ''])('rejects unready provider state %s', (state) => {
    const input = proof(); input.replacementFile.status = state
    expect(provesReadyReplacement(input)).toBe(false)
  })
  it('rejects a different current source revision', () => {
    const input = proof(); input.currentSource.rev = 'newer-rev'
    expect(provesReadyReplacement(input)).toBe(false)
  })
  it('rejects a mismatched provider size or parent', () => {
    const input = proof(); input.replacementFile.file_size = 42
    expect(provesReadyReplacement(input)).toBe(false)
    input.replacementFile.file_size = input.currentSource.size
    input.replacementFile.parent_id = 'different-folder'
    expect(provesReadyReplacement(input)).toBe(false)
  })
  it('rejects same source identity, same provider identity and older transfers', () => {
    const sameSource = proof(); sameSource.sourceId = sameSource.replacementSourceId
    expect(provesReadyReplacement(sameSource)).toBe(false)
    const sameFile = proof(); sameFile.original.frameio_file_id = sameFile.replacement.frameio_file_id
    expect(provesReadyReplacement(sameFile)).toBe(false)
    const older = proof(); older.replacement.created_at = '2026-09-20T12:00:00Z'
    expect(provesReadyReplacement(older)).toBe(false)
  })
  it('rejects incomplete database state and missing or invalid evidence', () => {
    const input = proof(); input.replacement.state = 'processing'
    expect(provesReadyReplacement(input)).toBe(false)
    input.replacement.state = 'ready'; input.original.created_at = 'invalid'
    expect(provesReadyReplacement(input)).toBe(false)
  })
})
