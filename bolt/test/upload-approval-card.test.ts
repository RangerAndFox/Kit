import { describe, expect, it } from 'vitest'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
import { decidedUploadMessage, uploadApprovalCard } from '../src/watchers/upload-approval-card'

const row = {
  id: 'request', state: 'awaiting', source_path: '/client-progress/edit.mov',
  source_payload: { subfolder: '01_Client Progress' }, suggested_name: 'R&F_Client_Project_Edit_V1.mov',
  approved_name: null, approved_by: null, decision: null,
} as UploadApproval

describe('shared upload decision feedback', () => {
  it('offers actions only while awaiting a decision', () => {
    expect(uploadApprovalCard(row, 'Test').blocks.some(b => b.type === 'actions')).toBe(true)
    for (const state of ['approved', 'uploading', 'complete', 'skipped', 'superseded', 'needs_review']) {
      expect(uploadApprovalCard({ ...row, state }, 'Test').blocks.some(b => b.type === 'actions')).toBe(false)
    }
  })
  it('shows the winning reviewer and escaped approved filename', () => {
    const approved = { ...row, state: 'approved', approved_by: 'U123', approved_name: 'R&F_Client_Project_Edit_V2.mov', decision: 'new' }
    const content = JSON.stringify(uploadApprovalCard(approved, 'Test'))
    expect(content).toContain('Approved by <@U123>')
    expect(content).toContain('Approved filename: R&amp;F_Client_Project_Edit_V2.mov')
    expect(content).not.toContain('Edit_V1.mov')
    expect(decidedUploadMessage(approved)).toContain('Your submission did not change the filename or queue another upload.')
    expect(decidedUploadMessage(approved)).toContain('<@U123>')
  })
  it('does not call skipped or superseded work an upload', () => {
    expect(decidedUploadMessage({ ...row, state: 'skipped', decision: 'skip', approved_by: 'U123' })).toMatch(/^Skipped by/)
    expect(decidedUploadMessage({ ...row, state: 'superseded' })).toContain('Review the latest request')
  })
})
