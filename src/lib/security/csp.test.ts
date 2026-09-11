import { it } from 'node:test'
import assert from 'node:assert/strict'
import { contentSecurityPolicy } from './csp'

it('production scripts require a nonce, with no eval or inline escape hatch', () => {
  const policy = contentSecurityPolicy('randomNonce123')
  const scripts = policy.split('; ').find(p => p.startsWith('script-src'))!
  assert.ok(scripts.includes("'nonce-randomNonce123'"))
  assert.ok(!scripts.includes('unsafe-inline'))
  assert.ok(!scripts.includes('unsafe-eval'))
  assert.ok(contentSecurityPolicy('randomNonce123', true).includes('unsafe-eval'))
  assert.throws(() => contentSecurityPolicy("injected'; script-src *"))
})
