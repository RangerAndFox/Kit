/**
 * New Project modal (buildNewProjectModal) — Client Contact field presence.
 *
 * Run: npx tsx --test src/lib/provisioner/modal.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildNewProjectModal, buildUpdateProjectModal } from './modal'

interface Block {
  type: string
  block_id?: string
  optional?: boolean
  element?: { type: string; action_id?: string }
  label?: { text?: string }
}

function blocksById(): Record<string, Block> {
  const modal = buildNewProjectModal('C123')
  const out: Record<string, Block> = {}
  for (const b of modal.blocks as Block[]) if (b.block_id) out[b.block_id] = b
  return out
}

describe('buildNewProjectModal — Client Contact input', () => {
  it('includes a client_contact input block with action_id "val"', () => {
    const b = blocksById().client_contact
    assert.ok(b, 'client_contact block is present')
    assert.equal(b.type, 'input')
    assert.equal(b.element?.type, 'plain_text_input')
    assert.equal(b.element?.action_id, 'val') // matches the submission-parser key
  })

  it('is optional (Client Contact is not forced required)', () => {
    assert.equal(blocksById().client_contact.optional, true)
  })

  it('is placed right after Client so the intake reads naturally', () => {
    const modal = buildNewProjectModal('C123')
    const ids = (modal.blocks as Block[]).map((b) => b.block_id).filter(Boolean)
    assert.equal(ids[ids.indexOf('client_name') + 1], 'client_contact')
  })

  it('keeps the existing required fields intact', () => {
    const byId = blocksById()
    for (const id of ['project_number', 'client_name', 'project_name', 'project_manager']) {
      assert.ok(byId[id], `${id} still present`)
      assert.notEqual(byId[id].optional, true) // these remain required
    }
  })

  it('requires both schedule dates and explains producer approval', () => {
    const modal = buildNewProjectModal('D1') as any
    const byId = Object.fromEntries(modal.blocks.filter((block: any) => block.block_id).map((block: any) => [block.block_id, block]))
    assert.notEqual(byId.start_date.optional, true)
    assert.notEqual(byId.deadline.optional, true)
    assert.match(byId.milestone_count.hint.text, /DMs the producer for approval/i)
  })
})

describe('buildUpdateProjectModal — pre-fill', () => {
  const modal = buildUpdateProjectModal({
    projectId: 'P1',
    workspaceId: 'WS',
    channelId: 'C1',
    snapshot: {
      projectNumber: '2601', clientName: 'Nike', clientContact: 'Jane',
      projectName: 'Summer Campaign', projectType: 'Brand Video',
      projectManagerSlackId: 'U_PROD', creativeDirectorSlackId: 'U_CD',
      startDate: '2026-01-01', targetDelivery: '2026-03-01', briefSummary: 'brief', budgetTotal: 120,
    },
  })
  const byId: Record<string, any> = {}
  for (const b of modal.blocks as any[]) if (b.block_id) byId[b.block_id] = b

  it('uses the kit_update_project callback and carries id + open-time snapshot in metadata', () => {
    assert.equal(modal.callback_id, 'kit_update_project')
    const meta = JSON.parse(modal.private_metadata)
    assert.equal(meta.project_id, 'P1')
    assert.equal(meta.workspace_id, 'WS')
    assert.equal(meta.channel_id, 'C1')
    assert.equal(meta.thread_ts, '')
    // The open-time snapshot is embedded so the submit handler diffs against what
    // the user was shown, not a fresh DB read.
    assert.equal(meta.snap.projectName, 'Summer Campaign')
    assert.equal(meta.snap.creativeDirectorSlackId, 'U_CD')
    assert.equal(meta.snap.targetDelivery, '2026-03-01')
  })

  it('shares the create modal block_ids so extraction is reusable', () => {
    for (const id of ['project_number', 'client_name', 'client_contact', 'project_name', 'project_type', 'project_manager', 'creative_director', 'start_date', 'deadline', 'description']) {
      assert.ok(byId[id], `${id} present`)
    }
  })

  it('pre-fills text, user, date, and select fields from the snapshot', () => {
    assert.equal(byId.project_number.element.initial_value, '2601')
    assert.equal(byId.client_name.element.initial_value, 'Nike')
    assert.equal(byId.project_name.element.initial_value, 'Summer Campaign')
    assert.equal(byId.project_manager.element.initial_user, 'U_PROD')
    assert.equal(byId.creative_director.element.initial_user, 'U_CD')
    assert.equal(byId.start_date.element.initial_date, '2026-01-01')
    assert.equal(byId.deadline.element.initial_date, '2026-03-01')
    assert.equal(byId.project_type.element.initial_option.value, 'Brand Video')
  })

  it('omits budget, services, and team_members inputs', () => {
    assert.equal(byId.budget, undefined)
    assert.equal(byId.services, undefined)
    assert.equal(byId.team_members, undefined)
  })

  it('opens even when optional fields are missing', () => {
    const m = buildUpdateProjectModal({ projectId: 'P', workspaceId: 'W', channelId: 'C', snapshot: { projectNumber: '1', clientName: 'X', projectName: 'Y' } })
    const ids: Record<string, any> = {}
    for (const b of m.blocks as any[]) if (b.block_id) ids[b.block_id] = b
    assert.equal(ids.creative_director.element.initial_user, undefined) // no CD → no initial_user
    assert.equal(ids.project_type.element.initial_option, undefined)
  })

  it('marks Producer/Project Type/Client optional so a Harvest-synced (null-those-fields) project is still submittable', () => {
    // syncProjectsFromHarvest inserts active projects with null project_manager,
    // null project_type, and a possibly-null client; a required field with no
    // value would make Slack reject ANY edit to such a project.
    assert.equal(byId.project_manager.optional, true)
    assert.equal(byId.project_type.optional, true)
    assert.equal(byId.client_name.optional, true)
    assert.equal(byId.project_number.optional, true)
  })
})
