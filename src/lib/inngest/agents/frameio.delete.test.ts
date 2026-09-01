import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { deleteFrameioProject } from './frameio'

beforeEach(() => {
  delete process.env.FRAMEIO_ADOBE_CLIENT_ID
  delete process.env.FRAMEIO_ADOBE_CLIENT_SECRET
  delete process.env.FRAMEIO_ADOBE_REFRESH_TOKEN
  process.env.FRAMEIO_TOKEN = 'static-test-token'
  process.env.FRAMEIO_ACCOUNT_ID = 'ACC'
  process.env.FRAMEIO_WORKSPACE_ID = 'WKS'
})

afterEach(() => {
  delete process.env.FRAMEIO_TOKEN
  delete process.env.FRAMEIO_ACCOUNT_ID
  delete process.env.FRAMEIO_WORKSPACE_ID
})

describe('deleteFrameioProject', () => {
  it('completes only after the project GET proves absence', async () => {
    const calls: Array<{ method: string; url: string }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || 'GET'
      calls.push({ method, url: String(input) })
      return method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response('{"errors":[]}', { status: 404 })
    }

    await deleteFrameioProject('project-1', { fetchImpl: fetchImpl as typeof fetch, maxAttempts: 1 })
    assert.deepEqual(calls.map((call) => call.method), ['DELETE', 'GET'])
  })

  it('does not mistake a router-level DELETE 404 for an absent project', async () => {
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'DELETE') {
        return new Response('{"errors":[{"detail":"no route found for DELETE /v4/accounts/ACC/workspaces/WKS/projects/project-1"}]}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return Response.json({ data: { id: 'project-1', status: 'active' } })
    }

    await assert.rejects(
      deleteFrameioProject('project-1', { fetchImpl: fetchImpl as typeof fetch, maxAttempts: 1 }),
      /still exists with status active.*DELETE route returned 404/i,
    )
  })

  it('accepts an already-absent project when both DELETE and verification return 404', async () => {
    const fetchImpl = async () => new Response('{"errors":[]}', { status: 404 })
    await deleteFrameioProject('project-1', { fetchImpl: fetchImpl as typeof fetch, maxAttempts: 1 })
  })
})
