import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMcpToken, verifyMcpToken } from './auth'

const secret = 'test-signing-secret-that-is-long-enough'

describe('MCP scoped credentials', () => {
  it('round-trips workspace and tool claims', () => {
    const token = createMcpToken({
      subject: 'managed-agent:test',
      workspaceId: 'workspace-a',
      tools: ['kit_get_project', 'kit_list_projects'],
    }, secret)
    assert.deepEqual(verifyMcpToken(token, secret), {
      subject: 'managed-agent:test',
      workspaceId: 'workspace-a',
      tools: ['kit_get_project', 'kit_list_projects'],
    })
  })

  it('rejects tampering, the wrong signer, and expired credentials', () => {
    const valid = createMcpToken({ subject: 'a', workspaceId: 'w', tools: ['t'] }, secret)
    assert.equal(verifyMcpToken(`${valid}x`, secret), null)
    assert.equal(verifyMcpToken(valid, `${secret}-wrong`), null)
    const expired = createMcpToken({ subject: 'a', workspaceId: 'w', tools: ['t'], expiresAt: 1 }, secret)
    assert.equal(verifyMcpToken(expired, secret), null)
  })
})
