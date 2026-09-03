import { describe, expect, it } from 'vitest'
import { buildConfirmCard } from './keyword'
import { buildOnboardEditModal, parseOnboardEditSubmission } from './modal'

const project = { id: 'project-1', project_code: '2520', client: 'Microsoft', name: 'Icertis' }

describe('freelancer onboarding review', () => {
  it('offers Onboard, Edit, and Cancel in that order', () => {
    const card = buildConfirmCard({ artistName: 'Taylor Smith', artistEmail: 'taylor@example.com', project })
    const actions = card.blocks[1] as unknown as { elements: Array<{ action_id: string }> }
    expect(actions.elements.map((element) => element.action_id)).toEqual([
      'kit_onboard_confirm',
      'kit_onboard_edit',
      'kit_onboard_cancel',
    ])
  })

  it('prefills the correction modal and parses the corrected values', () => {
    const modal = buildOnboardEditModal({
      project,
      artistName: 'wrongname',
      artistEmail: 'taylor@example.com',
      channelId: 'C1',
      messageTs: '123.456',
    }) as unknown as {
      private_metadata: string
      blocks: Array<{ element: { initial_value?: string } }>
    }
    expect(modal.blocks[1].element.initial_value).toBe('wrongname')
    expect(modal.blocks[2].element.initial_value).toBe('taylor@example.com')

    const parsed = parseOnboardEditSubmission({
      private_metadata: modal.private_metadata,
      state: { values: {
        artist_name: { value: { value: ' Taylor Smith ' } },
        artist_email: { value: { value: ' taylor@example.com ' } },
        artist_legal_name: { value: { value: ' Taylor Smith LLC ' } },
      } },
    })
    expect(parsed).toEqual({
      projectId: 'project-1',
      channelId: 'C1',
      messageTs: '123.456',
      artistName: 'Taylor Smith',
      artistEmail: 'taylor@example.com',
      artistLegalName: 'Taylor Smith LLC',
    })
  })
})
