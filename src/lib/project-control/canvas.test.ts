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
  formatSlackResponseMessages,
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

interface EditChange {
  operation: string
  title_content?: { type?: string; markdown: string }
  document_content?: { type?: string; markdown: string }
}

describe('editControlCanvas — two single-op requests (Slack allows one op per call)', () => {
  it('issues exactly two canvases.edit calls: replace THEN rename, each a native one-op array', async () => {
    const r = recorder()
    __setCanvasTransportForTests(r.transport)

    await editControlCanvas({ canvasId: 'C1', title: 'New Title', markdown: '# regenerated' })

    const edits = r.calls.filter((c) => c.method === 'canvases.edit')
    assert.equal(edits.length, 2, 'exactly two canvases.edit calls')

    // Deterministic order: replace before rename.
    const first = edits[0].payload
    const second = edits[1].payload
    assert.equal(first.canvas_id, 'C1')
    assert.equal(second.canvas_id, 'C1')

    // Each request: a NATIVE array (not a JSON string) of length exactly one.
    for (const e of edits) {
      assert.ok(Array.isArray(e.payload.changes), '`changes` is a native array')
      assert.notEqual(typeof e.payload.changes, 'string')
      assert.equal((e.payload.changes as unknown[]).length, 1, 'exactly one operation per call')
    }

    // Exact replace payload (first call).
    const c1 = (first.changes as EditChange[])[0]
    assert.deepEqual(c1, {
      operation: 'replace',
      document_content: { type: 'markdown', markdown: '# regenerated' },
    })

    // Exact rename payload (second call).
    const c2 = (second.changes as EditChange[])[0]
    assert.deepEqual(c2, {
      operation: 'rename',
      title_content: { type: 'markdown', markdown: 'New Title' },
    })
  })

  it('first-call (replace) failure prevents the rename call', async () => {
    const r = recorder()
    let calls = 0
    __setCanvasTransportForTests(async (kind, method, payload) => {
      if (method === 'canvases.edit') {
        calls++
        throw new Error('Slack canvases.edit: some_error')
      }
      return r.transport(kind, method, payload)
    })

    await assert.rejects(
      () => editControlCanvas({ canvasId: 'C1', title: 'T', markdown: '# body' }),
      /Slack canvases.edit: some_error/,
    )
    assert.equal(calls, 1, 'only the replace call was attempted; rename was not issued')
  })

  it('second-call (rename) failure propagates after both calls were attempted', async () => {
    const seen: string[] = []
    __setCanvasTransportForTests(async (_kind, method, payload) => {
      if (method === 'canvases.edit') {
        const op = ((payload.changes as EditChange[])[0]).operation
        seen.push(op)
        if (op === 'rename') throw new Error('Slack canvases.edit: rename_boom')
        return { ok: true }
      }
      return { ok: true }
    })

    await assert.rejects(
      () => editControlCanvas({ canvasId: 'C1', title: 'T', markdown: '# body' }),
      /rename_boom/,
    )
    assert.deepEqual(seen, ['replace', 'rename'], 'replace succeeded, then rename was attempted and failed')
  })

  it('retry after partial success re-issues BOTH deterministic ops (idempotent), never creating a canvas', async () => {
    const r = recorder()
    __setCanvasTransportForTests(r.transport)

    // Simulate a first attempt where rename failed after replace succeeded, then
    // a full retry. The retry must re-issue replace AND rename against the same id.
    await editControlCanvas({ canvasId: 'C1', title: 'New Title', markdown: '# regenerated' })

    const edits = r.calls.filter((c) => c.method === 'canvases.edit')
    assert.equal(edits.length, 2)
    assert.deepEqual(
      edits.map((e) => (e.payload.changes as EditChange[])[0].operation),
      ['replace', 'rename'],
    )
    // canvas_id unchanged and no create call is ever issued from the edit path.
    assert.ok(edits.every((e) => e.payload.canvas_id === 'C1'))
    assert.ok(!r.calls.some((c) => c.method === 'canvases.create'), 'edit path never creates a canvas')
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

  it('accepts a well-formed single-op change set', () => {
    assert.doesNotThrow(() =>
      assertValidCanvasChanges([{ operation: 'rename', title_content: { type: 'markdown', markdown: 'T' } }]),
    )
    assert.doesNotThrow(() =>
      assertValidCanvasChanges([{ operation: 'replace', document_content: { type: 'markdown', markdown: '# body' } }]),
    )
  })
})

describe('formatSlackResponseMessages (defensive error enrichment)', () => {
  it('appends response_metadata.messages when present', () => {
    const out = formatSlackResponseMessages({
      ok: false,
      error: 'invalid_arguments',
      response_metadata: { messages: ['[ERROR] too many operations', 'only one op allowed'] },
    })
    assert.equal(out, ' ([ERROR] too many operations; only one op allowed)')
  })

  it('returns empty string (no throw) when response_metadata is missing', () => {
    assert.equal(formatSlackResponseMessages({ ok: false, error: 'invalid_arguments' }), '')
  })

  it('tolerates malformed response_metadata without throwing', () => {
    // messages not an array
    assert.equal(formatSlackResponseMessages({ ok: false, response_metadata: { messages: 'nope' } }), '')
    // response_metadata not an object
    assert.equal(formatSlackResponseMessages({ ok: false, response_metadata: 42 }), '')
    // null metadata
    assert.equal(formatSlackResponseMessages({ ok: false, response_metadata: null }), '')
    // messages array with non-string / empty entries → filtered out
    assert.equal(formatSlackResponseMessages({ ok: false, response_metadata: { messages: [1, '', '  ', null] } }), '')
  })

  it('never exposes unrelated raw response fields', () => {
    const out = formatSlackResponseMessages({
      ok: false,
      error: 'invalid_arguments',
      secret_token: 'do-not-leak',
      response_metadata: { messages: ['visible detail'], warnings: ['hidden'] },
    })
    assert.equal(out, ' (visible detail)')
    assert.ok(!out.includes('do-not-leak'))
    assert.ok(!out.includes('hidden'))
  })
})
