import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { completeDeliveryFileNotification } from './delivery-crons'

describe('completeDeliveryFileNotification', () => {
  it('marks a Dropbox file only after Slack confirms the post', async () => {
    const order: string[] = []
    const ok = await completeDeliveryFileNotification({
      dropboxId: 'dbx-1',
      post: async () => { order.push('post'); return '123.456' },
      mark: async () => { order.push('mark') },
    })
    assert.equal(ok, true)
    assert.deepEqual(order, ['post', 'mark'])
  })

  it('leaves the file eligible when Slack does not confirm the post', async () => {
    let marked = false
    const ok = await completeDeliveryFileNotification({
      dropboxId: 'dbx-2',
      post: async () => null,
      mark: async () => { marked = true },
    })
    assert.equal(ok, false)
    assert.equal(marked, false)
  })
})
