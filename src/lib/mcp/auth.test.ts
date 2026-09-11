import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMcpToken, verifyMcpToken, mcpTokenFingerprint } from './auth'
import crypto from 'node:crypto'

const secret = 'test-signing-secret-that-is-long-enough'

describe('MCP scoped credentials', () => {
  it('round-trips workspace and tool claims', () => {
    const token = createMcpToken({
      subject: 'managed-agent:test',
      workspaceId: 'workspace-a',
      tools: ['kit_get_project', 'kit_list_projects'],
    }, secret)
    const principal = verifyMcpToken(token, secret)
    assert.equal(principal?.workspaceId, 'workspace-a')
    assert.equal(principal?.subject, 'managed-agent:test')
    assert.deepEqual(principal?.tools, ['kit_get_project', 'kit_list_projects'])
    assert.ok(principal?.tokenId)
    assert.ok(principal?.expiresAt && principal.expiresAt > Date.now() / 1000)
  })

  it('rejects tampering, the wrong signer, and expired credentials', () => {
    const valid = createMcpToken({ subject: 'a', workspaceId: 'w', tools: ['t'] }, secret)
    assert.equal(verifyMcpToken(`${valid}x`, secret), null)
    assert.equal(verifyMcpToken(valid, `${secret}-wrong`), null)
    assert.throws(() => createMcpToken({ subject: 'a', workspaceId: 'w', tools: ['t'], expiresAt: 1 }, secret))
  })
})

function legacyToken(exp?: number) {
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: 'a', workspace_id: 'w', tools: ['t'], ...(exp ? { exp } : {}) })).toString('base64url')
  return `kit1.${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`
}

it('rejects expired, unbounded, and overlong signed credentials', () => {
  assert.equal(verifyMcpToken(legacyToken(), secret), null)
  assert.equal(verifyMcpToken(legacyToken(1), secret), null)
  assert.equal(verifyMcpToken(legacyToken(Math.floor(Date.now() / 1000) + 100 * 86400), secret), null)
})

it('revokes one credential without invalidating another', () => {
  const a = createMcpToken({ subject: 'a', workspaceId: 'w', tools: ['t'] }, secret)
  const b = createMcpToken({ subject: 'b', workspaceId: 'w', tools: ['t'] }, secret)
  const previous = process.env.KIT_MCP_REVOKED_TOKEN_HASHES
  try {
    process.env.KIT_MCP_REVOKED_TOKEN_HASHES = mcpTokenFingerprint(a)
    assert.equal(verifyMcpToken(a, secret), null)
    assert.ok(verifyMcpToken(b, secret))
  } finally {
    if (previous === undefined) delete process.env.KIT_MCP_REVOKED_TOKEN_HASHES
    else process.env.KIT_MCP_REVOKED_TOKEN_HASHES = previous
  }
})
