/**
 * bindProjectControl lifecycle tests via injected fake ports.
 *
 * Run: npx tsx --test src/lib/project-control/creation.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindProjectControl,
  type CreationDeps,
  type CreationStorePort,
  type CreationCanvasPort,
  type CreationSheetsPort,
} from './creation'
import { MASTER_HEADERS, type SheetCell } from './render'
import type { WorkbookConfig } from './types'
import type { BindingRow } from './store'
import type { CanvasReconcile } from './canvas'

const CONFIG: WorkbookConfig = { spreadsheetId: 'sid', sheetId: 0, headerRow: 3, templateChannelId: 'C0' }
const TEMPLATE = '# 🎬 2xxx Client Project\n\n| ### **Client** |  |\n'

function rowCells(): SheetCell[] {
  return MASTER_HEADERS.map((h) => {
    if (h === 'Project Number') return { formattedValue: '2601', effectiveValue: { stringValue: '2601' } }
    if (h === 'Client') return { formattedValue: 'Nike', effectiveValue: { stringValue: 'Nike' } }
    if (h === 'Project Name') return { formattedValue: 'S', effectiveValue: { stringValue: 'S' } }
    return {}
  })
}

interface FakeStore extends CreationStorePort {
  b: BindingRow
  claimHolders: string[]
  releaseHolders: string[]
}

function makeStore(initial: Partial<BindingRow> = {}): FakeStore {
  const b: BindingRow = {
    id: 'b1', project_id: 'proj', spreadsheet_id: 'sid', sheet_id: 0,
    row_metadata_id: null, source_template_file_id: null, source_template_hash: null,
    template_markdown: null, canvas_id: null, canvas_url: null,
    creation_state: 'pending_sheet', sync_status: 'pending',
    last_row_hash: null, last_synced_at: null, error: null, error_notified_key: null,
    created_at: 't', updated_at: 't', ...initial,
  }
  const claimHolders: string[] = []
  const releaseHolders: string[] = []
  return {
    b,
    claimHolders,
    releaseHolders,
    ensureBinding: async () => b,
    getBindingByProject: async () => b,
    updateBinding: async (_p: string, patch: Partial<BindingRow>) => { Object.assign(b, patch) },
    claimWorkbookLease: async (_s: string, _k: 'creation' | 'sync', holder: string) => { claimHolders.push(holder); return true },
    renewWorkbookLease: async () => true,
    releaseWorkbookLease: async (_s: string, _k: 'creation' | 'sync', holder: string) => { releaseHolders.push(holder) },
  }
}

const okSheets: CreationSheetsPort = {
  createBoundRow: async () => ({ metadataId: 10, rowIndex: 5, alreadyBound: false }),
  searchRowMetadata: async () => ({ metadataId: 10, rowIndex: 5 }),
  readRow: async () => rowCells(),
}

interface Counters { created: number; edited: number }

function makeDeps(over: {
  store?: FakeStore
  canvas?: CreationCanvasPort
  enabled?: boolean
  config?: WorkbookConfig | null
} = {}): { deps: CreationDeps; store: FakeStore; counters: Counters } {
  const counters: Counters = { created: 0, edited: 0 }
  const store = over.store ?? makeStore()
  const canvas: CreationCanvasPort = over.canvas ?? {
    createControlCanvas: async () => { counters.created++; return { canvasId: 'C1', canvasUrl: 'u' } },
    editControlCanvas: async () => { counters.edited++ },
    reconcileControlCanvas: async (): Promise<CanvasReconcile> => ({ status: 'absent' }),
  }
  const deps: CreationDeps = {
    sheets: okSheets,
    canvas,
    store,
    config: over.config !== undefined ? over.config : CONFIG,
    enabled: over.enabled !== undefined ? over.enabled : true,
    now: () => 't',
  }
  return { deps, store, counters }
}

const slackResult = (over: Record<string, unknown> = {}) => ({
  id: 'chan',
  data: { channelId: 'chan', controlTemplate: { fileId: 'F', markdown: TEMPLATE, hash: 'h' }, controlTemplateError: null, ...over },
})

describe('bindProjectControl', () => {
  it('binds sheet + canvas and reaches connected/synced', async () => {
    const { deps, store, counters } = makeDeps()
    const r = await bindProjectControl({ projectId: 'proj', submission: { projectNumber: '2601', clientName: 'Nike', projectName: 'S' }, slackResult: slackResult() }, deps)
    assert.equal(r.status, 'connected')
    assert.equal(store.b.canvas_id, 'C1')
    assert.equal(store.b.creation_state, 'connected')
    assert.equal(store.b.sync_status, 'synced')
    assert.equal(counters.created, 1)
  })

  it('is skipped when the creation gate is disabled', async () => {
    const { deps, counters } = makeDeps({ enabled: false })
    const r = await bindProjectControl({ projectId: 'proj', submission: {}, slackResult: slackResult() }, deps)
    assert.equal(r.status, 'skipped')
    assert.equal(counters.created, 0)
  })

  it('fails closed (Sheet bound, no Canvas) when the template is unresolved', async () => {
    const { deps, store, counters } = makeDeps()
    const r = await bindProjectControl(
      { projectId: 'proj', submission: { projectNumber: '2601' }, slackResult: slackResult({ controlTemplate: null, controlTemplateError: 'multiple' }) },
      deps,
    )
    assert.equal(r.status, 'error')
    assert.match(r.reason || '', /template_unresolved/)
    assert.equal(store.b.creation_state, 'sheet_bound') // row bound, not connected
    assert.equal(counters.created, 0) // no canvas fabricated
  })

  it('stops without a second canvas when an ambiguous create finds multiple candidates', async () => {
    const store = makeStore()
    const { deps } = makeDeps({
      store,
      canvas: {
        createControlCanvas: async () => { throw new Error('timeout') },
        editControlCanvas: async () => {},
        reconcileControlCanvas: async (): Promise<CanvasReconcile> => ({ status: 'ambiguous', canvasIds: ['a', 'b'] }),
      },
    })
    const r = await bindProjectControl({ projectId: 'proj', submission: { projectNumber: '2601' }, slackResult: slackResult() }, deps)
    assert.equal(r.status, 'error')
    assert.equal(r.reason, 'canvas_ambiguous')
    assert.equal(store.b.canvas_id, null)
  })

  it('binds the single existing candidate when an ambiguous create reconciles to one', async () => {
    const store = makeStore()
    let edits = 0
    const { deps } = makeDeps({
      store,
      canvas: {
        createControlCanvas: async () => { throw new Error('timeout') },
        editControlCanvas: async () => { edits++ },
        reconcileControlCanvas: async (): Promise<CanvasReconcile> => ({ status: 'found', canvasId: 'CX' }),
      },
    })
    const r = await bindProjectControl({ projectId: 'proj', submission: { projectNumber: '2601', clientName: 'Nike', projectName: 'S' }, slackResult: slackResult() }, deps)
    assert.equal(r.status, 'connected')
    assert.equal(store.b.canvas_id, 'CX')
    assert.ok(edits >= 1)
  })

  it('resumes from a connected binding by editing (idempotent), not re-creating', async () => {
    const store = makeStore({ creation_state: 'connected', canvas_id: 'C1', row_metadata_id: 10, template_markdown: TEMPLATE })
    let edits = 0
    const { deps } = makeDeps({
      store,
      canvas: {
        createControlCanvas: async () => { throw new Error('should not create') },
        editControlCanvas: async () => { edits++ },
        reconcileControlCanvas: async (): Promise<CanvasReconcile> => ({ status: 'absent' }),
      },
    })
    const r = await bindProjectControl({ projectId: 'proj', submission: { projectNumber: '2601', clientName: 'Nike', projectName: 'S' }, slackResult: slackResult() }, deps)
    assert.equal(r.status, 'connected')
    assert.equal(edits, 1)
  })

  it('uses a unique creation lease holder per acquisition, retained for release', async () => {
    const store = makeStore()
    const sub = { projectNumber: '2601', clientName: 'Nike', projectName: 'S' }
    await bindProjectControl({ projectId: 'proj', submission: sub, slackResult: slackResult() }, makeDeps({ store }).deps)
    await bindProjectControl({ projectId: 'proj', submission: sub, slackResult: slackResult() }, makeDeps({ store }).deps)
    assert.equal(store.claimHolders.length, 2)
    assert.notEqual(store.claimHolders[0], store.claimHolders[1]) // unique per acquisition
    assert.ok(store.claimHolders[0].startsWith('create:proj:'))
    assert.deepEqual(store.claimHolders, store.releaseHolders) // exact token released
  })

  it('retries the creation lease on contention, then proceeds', async () => {
    let calls = 0
    const store: FakeStore = { ...makeStore(), claimWorkbookLease: async () => { calls++; return calls >= 3 } }
    const deps = makeDeps({ store }).deps
    deps.sleep = async () => {} // instant, no real waiting
    const r = await bindProjectControl(
      { projectId: 'proj', submission: { projectNumber: '2601', clientName: 'Nike', projectName: 'S' }, slackResult: slackResult() },
      deps,
    )
    assert.equal(r.status, 'connected')
    assert.equal(calls, 3) // failed twice, acquired on the third attempt
  })

  it('returns a visible deferred after the lease retry window is exhausted', async () => {
    const store: FakeStore = { ...makeStore(), claimWorkbookLease: async () => false }
    const deps = makeDeps({ store }).deps
    deps.sleep = async () => {}
    const r = await bindProjectControl({ projectId: 'proj', submission: {}, slackResult: slackResult() }, deps)
    assert.equal(r.status, 'deferred')
  })
})
