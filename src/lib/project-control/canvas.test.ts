/**
 * Project Control Canvas edit-path tests via an injected Slack transport
 * (no network, no token). These lock the one-way contract at the Slack boundary:
 * the managed Canvas is created read-only for the channel, and every update is a
 * full-document replace (never a merge that could preserve manual edits).
 *
 * Run: npx tsx --test src/lib/project-control/canvas.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createControlCanvas,
  editControlCanvas,
  CONTROL_CANVAS_ACCESS_LEVEL,
  __setCanvasTransportForTests,
} from './canvas'

interface Call {
  kind: 'post' | 'get'
  method: string
  payload: Record<string, unknown>
}

function recorder(overrides: Record<string, Record<string, unknown>> = {}) {
  const calls: Call[] = []
  const transport = async (
    kind: 'post' | 'get',
    method: string,
    payload: Record<string, unknown>,
  ) => {
    calls.push({ kind, method, payload })
    return { ok: true, ...(overrides[method] || {}) }
  }
  return { calls, transport }
}

afterEach(() => __setCanvasTransportForTests(null))

describe('createControlCanvas read-only enforcement', () => {
  it('sets the channel to read-only (never write) for the managed canvas', async () => {
    const r = recorder({ 'canvases.create': { canvas_id: 'C_NEW', canvas_url: 'https://x' } })
    __setCanvasTransportForTests(r.transport)

    const handle = await createControlCanvas({ channelId: 'CH1', title: 'T', markdown: '# body' })
    assert.equal(handle.canvasId, 'C_NEW')

    const access = r.calls.find((c) => c.method === 'canvases.access.set')
    assert.ok(access, 'access.set is called')
    assert.equal(access!.payload.access_level, 'read')
    assert.equal(CONTROL_CANVAS_ACCESS_LEVEL, 'read')
    assert.deepEqual(access!.payload.channel_ids, ['CH1'])
    assert.equal(access!.payload.canvas_id, 'C_NEW')
    // Guard against a regression back to write access on the managed canvas.
    assert.notEqual(access!.payload.access_level, 'write')
  })

  it('still returns the canvas when the read-only grant fails (non-fatal)', async () => {
    let created = false
    __setCanvasTransportForTests(async (_kind, method) => {
      if (method === 'canvases.create') {
        created = true
        return { ok: true, canvas_id: 'C_NEW' }
      }
      if (method === 'canvases.access.set') throw new Error('slack down')
      return { ok: true }
    })
    const handle = await createControlCanvas({ channelId: 'CH1', title: 'T', markdown: '# body' })
    assert.ok(created)
    assert.equal(handle.canvasId, 'C_NEW')
  })
})

describe('editControlCanvas deterministic full replace', () => {
  it('issues a full-document replace (not a merge) so manual edits are discarded', async () => {
    const r = recorder()
    __setCanvasTransportForTests(r.transport)

    await editControlCanvas({ canvasId: 'C1', title: 'New Title', markdown: '# regenerated' })

    const edit = r.calls.find((c) => c.method === 'canvases.edit')
    assert.ok(edit, 'canvases.edit is called')
    assert.equal(edit!.payload.canvas_id, 'C1')
    // `changes` is a JSON-encoded STRING per the Slack API contract.
    const changes = JSON.parse(edit!.payload.changes as string) as Array<{
      operation: string
      document_content?: { markdown: string }
    }>
    const replace = changes.find((c) => c.operation === 'replace')
    assert.ok(replace, 'a full replace operation is present')
    assert.equal(replace!.document_content!.markdown, '# regenerated')
    // No partial/insert/append op that would retain existing canvas content.
    assert.ok(!changes.some((c) => ['insert_after', 'insert_before', 'append'].includes(c.operation)))
  })
})
