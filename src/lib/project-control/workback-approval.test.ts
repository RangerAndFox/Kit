import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateWorkback } from './workback'
import {
  WORKBACK_APPROVE_ACTION,
  WORKBACK_REGENERATE_ACTION,
  WORKBACK_REGENERATE_VIEW,
  buildWorkbackDraftMessage,
  buildWorkbackRegenerateModal,
} from './workback-approval'

describe('workback producer approval UI', () => {
  const rows = generateWorkback({
    startDate: '2026-08-28', deliveryDate: '2026-09-04', milestoneCount: 4,
    template: 'Internal Project', draft: true,
  })

  it('sends a draft-only card with approve, regenerate, and Sheet editing paths', () => {
    const message = buildWorkbackDraftMessage({
      projectId: 'project-id', projectName: 'Launch', projectNumber: '2637',
      producerSlackId: 'D123', rows, spreadsheetId: 'sheet-id',
    }) as any
    assert.equal(message.channel, 'D123')
    assert.match(message.text, /approval needed/i)
    assert.match(message.blocks[1].text.text, /remains \*Draft\*/)
    assert.match(message.blocks[2].text.text, /Final Delivery/)
    assert.deepEqual(message.blocks[3].elements.map((button: any) => button.action_id), [
      WORKBACK_APPROVE_ACTION, WORKBACK_REGENERATE_ACTION, 'kit_workback_open_sheet',
    ])
  })

  it('opens a bounded regeneration modal with current dates and values', () => {
    const modal = buildWorkbackRegenerateModal({
      projectId: 'project-id', projectNumber: '2637', startDate: '2026-08-28',
      deadline: '2026-09-04', template: 'Fast-Turn', milestoneCount: 5,
    }) as any
    assert.equal(modal.callback_id, WORKBACK_REGENERATE_VIEW)
    assert.equal(JSON.parse(modal.private_metadata).projectId, 'project-id')
    assert.equal(modal.blocks[0].element.initial_date, '2026-08-28')
    assert.equal(modal.blocks[3].element.initial_value, '5')
  })
})
