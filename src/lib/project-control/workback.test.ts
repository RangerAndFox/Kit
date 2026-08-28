import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateWorkback, matchMilestone, suggestMilestoneNames } from './workback'

describe('workback generation', () => {
  it('spreads milestones over business days and pins final delivery', () => {
    const rows = generateWorkback({ startDate: '2026-08-28', deliveryDate: '2026-09-11', milestoneCount: 5, template: 'Fast-Turn', today: '2026-08-28' })
    assert.equal(rows.length, 5)
    assert.equal(rows[0].startDate, '2026-08-28')
    assert.equal(rows.at(-1)?.dueDate, '2026-09-11')
    assert.ok(rows.every((r) => ![0, 6].includes(new Date(`${r.dueDate}T00:00:00Z`).getUTCDay())))
  })
  it('always ends suggestions with final delivery', () => assert.equal(suggestMilestoneNames('Standard Sizzle', 6).at(-1), 'Final Delivery'))
  it('keeps every generated row inactive while producer approval is pending', () => {
    const rows = generateWorkback({ startDate: '2026-08-28', deliveryDate: '2026-09-11', milestoneCount: 5, template: 'Fast-Turn', today: '2026-08-28', draft: true })
    assert.ok(rows.every((row) => row.status === 'Not Started'))
  })
  it('uses honest generic names for Custom instead of silently using Standard Sizzle', () => {
    assert.deepEqual(suggestMilestoneNames('Custom', 4), ['Milestone 1', 'Milestone 2', 'Milestone 3', 'Final Delivery'])
  })
  it('matches a share filename to its milestone', () => assert.deepEqual(matchMilestone('2637_Boardomatic_V2_0827.mp4', ['Script V2', 'Boardomatic V2']), { task: 'Boardomatic V2', confidence: 'exact' }))
})
