import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSingleStudio, isStudioWorkerAuthorized } from './auth'

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

  it('rejects same-character-length multibyte tokens without throwing', () => {
    const request = new Request('https://kit.test/api/internal/studio-worker', { headers: { authorization: `Bearer ${'é'.repeat(48)}` } })
    assert.equal(isStudioWorkerAuthorized(request, { KIT_STUDIO_WORKER_SECRET: secret }), false)
  })
  it('fails closed on absent or multiple studio workspaces', () => {
    assert.equal(isSingleStudio(null), false)
    assert.equal(isSingleStudio([]), false)
    assert.equal(isSingleStudio([{ id: 'a' }]), true)
    assert.equal(isSingleStudio([{ id: 'a' }, { id: 'b' }]), false)
  })
})
