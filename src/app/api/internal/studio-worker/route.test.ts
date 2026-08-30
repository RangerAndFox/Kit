import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isStudioWorkerAuthorized } from './auth'

describe('studio worker broker authentication', () => {
  const secret = 'a'.repeat(48)
  it('fails closed when the dedicated secret is absent, short, or mismatched', () => {
    const request = new Request('https://kit.test/api/internal/studio-worker', { headers: { authorization: `Bearer ${secret}` } })
    assert.equal(isStudioWorkerAuthorized(request, {}), false)
    assert.equal(isStudioWorkerAuthorized(request, { KIT_STUDIO_WORKER_SECRET: 'short' }), false)
    assert.equal(isStudioWorkerAuthorized(request, { KIT_STUDIO_WORKER_SECRET: 'b'.repeat(48) }), false)
  })

  it('accepts only the exact dedicated worker secret', () => {
    const request = new Request('https://kit.test/api/internal/studio-worker', { headers: { authorization: `Bearer ${secret}` } })
    assert.equal(isStudioWorkerAuthorized(request, { KIT_STUDIO_WORKER_SECRET: secret }), true)
  })
})
