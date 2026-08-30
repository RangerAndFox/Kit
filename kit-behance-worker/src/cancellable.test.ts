import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCancellable } from './cancellable.js'

describe('browser job cancellation', () => {
  it('aborts and waits for cleanup before reporting a timeout', async () => {
    let cleaned = false
    await assert.rejects(
      runCancellable(
        (signal) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            cleaned = true
            reject(new Error('browser page closed'))
          }, { once: true })
        }),
        5,
        'timed out',
      ),
      /timed out/,
    )
    assert.equal(cleaned, true)
  })
})
