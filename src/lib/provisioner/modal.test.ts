/**
 * New Project modal (buildNewProjectModal) — Client Contact field presence.
 *
 * Run: npx tsx --test src/lib/provisioner/modal.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildNewProjectModal } from './modal'

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
})
