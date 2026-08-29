import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildInitialBrain, reconcileProjectIdentity } from './seed'

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', workspace_id: 'w1', name: 'Original', client: 'Internal',
  project_code: '2697-Internal', project_type: 'Other', status: 'active',
  start_date: '2026-08-31', target_delivery: '2026-09-11', budget_total: 10,
  brief_summary: 'Test brief', sow_summary: null, external_links: null,
  project_manager_slack_id: 'U1', slack_channel_id: 'C1', ...overrides,
}) as any

describe('reconcileProjectIdentity', () => {
  it('refreshes seeded identity while preserving accumulated decisions', () => {
    const brain = buildInitialBrain(project(), [])
    const log = brain.sections.find((s) => s.heading === 'Recent decisions (log)')!
    log.bullets.push({ text: 'Producer-approved creative direction.', provenance: { src: 'slack:1' }, checked: null })

    const changed = reconcileProjectIdentity(brain, project({ name: 'Updated', client: 'Nike', target_delivery: '2026-09-18' }))

    assert.equal(changed, true)
    assert.equal(brain.title, 'Brain — Updated (2697-Internal)')
    assert.match(brain.sections.find((s) => s.heading === 'Operating context')!.bullets[0].text, /Client: Nike\. Project: Updated\./)
    assert.ok(log.bullets.some((b) => b.text === 'Producer-approved creative direction.'))
  })

  it('is a no-op when authoritative identity is unchanged', () => {
    const brain = buildInitialBrain(project(), [])
    assert.equal(reconcileProjectIdentity(brain, project()), false)
  })
})
