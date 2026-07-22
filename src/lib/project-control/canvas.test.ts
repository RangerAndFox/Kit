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
  assertValidCanvasChanges,
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
    // `changes` must be a NATIVE array on this application/json transport — a
    // JSON-stringified value is rejected by Slack as `invalid_arguments`.
    assert.ok(Array.isArray(edit!.payload.changes), '`changes` is a native array, not a JSON string')
    const changes = edit!.payload.changes as Array<{
      operation: string
      title_content?: { markdown: string }
      document_content?: { markdown: string }
    }>
    // Inspect the operations directly (no JSON.parse).
    const rename = changes.find((c) => c.operation === 'rename')
    assert.ok(rename, 'a rename operation is present')
    assert.equal(rename!.title_content!.markdown, 'New Title')
    const replace = changes.find((c) => c.operation === 'replace')
    assert.ok(replace, 'a full replace operation is present')
    assert.equal(replace!.document_content!.markdown, '# regenerated')
    // No partial/insert/append op that would retain existing canvas content.
    assert.ok(!changes.some((c) => ['insert_after', 'insert_before', 'append'].includes(c.operation)))
  })

  it('records both create.document_content and edit.changes as native, non-string values', async () => {
    const r = recorder({ 'canvases.create': { canvas_id: 'C_NEW' } })
    __setCanvasTransportForTests(r.transport)

    await createControlCanvas({ channelId: 'CH1', title: 'T', markdown: '# body' })
    await editControlCanvas({ canvasId: 'C1', title: 'New Title', markdown: '# regenerated' })

    const create = r.calls.find((c) => c.method === 'canvases.create')
    const edit = r.calls.find((c) => c.method === 'canvases.edit')
    // Parity: complex fields go over the JSON transport as native structures,
    // never as pre-stringified strings.
    assert.equal(typeof create!.payload.document_content, 'object')
    assert.notEqual(typeof create!.payload.document_content, 'string')
    assert.ok(Array.isArray(edit!.payload.changes))
    assert.notEqual(typeof edit!.payload.changes, 'string')
  })
})

describe('assertValidCanvasChanges guard', () => {
  it('rejects a JSON-stringified changes payload (the production regression)', () => {
    const stringified = JSON.stringify([{ operation: 'replace', document_content: { type: 'markdown', markdown: '# x' } }])
    assert.throws(() => assertValidCanvasChanges(stringified), /must be a native array/)
  })

  it('rejects a rename operation missing title_content', () => {
    assert.throws(
      () => assertValidCanvasChanges([{ operation: 'rename' }]),
      /rename operation requires `title_content.markdown`/,
    )
  })

  it('rejects a replace operation missing document_content', () => {
    assert.throws(
      () => assertValidCanvasChanges([{ operation: 'replace' }]),
      /replace operation requires `document_content.markdown`/,
    )
  })

  it('accepts a well-formed rename + replace change set', () => {
    assert.doesNotThrow(() =>
      assertValidCanvasChanges([
        { operation: 'rename', title_content: { type: 'markdown', markdown: 'T' } },
        { operation: 'replace', document_content: { type: 'markdown', markdown: '# body' } },
      ]),
    )
  })
})
