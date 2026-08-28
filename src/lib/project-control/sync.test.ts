/**
 * runProjectControlSync tests via injected fake ports.
 *
 * Run: npx tsx --test src/lib/project-control/sync.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runProjectControlSync, projectControlSync, projectControlSyncOnEdit, type SyncDeps } from '../inngest/project-control-sync'
import { MASTER_HEADERS, normalizeRow, sourceRowHash, type SheetCell } from './render'
import type { WorkbookConfig } from './types'
import type { BindingRow, SyncStateRow } from './store'

const CONFIG: WorkbookConfig = { spreadsheetId: 'sid', sheetId: 0, headerRow: 3, templateChannelId: 'C0' }
const TEMPLATE = '# 🎬 2xxx Client Project\n\n| ### **Client** |  |\n'

function cells(): SheetCell[] {
  return MASTER_HEADERS.map((h) => {
    if (h === 'Client') return { formattedValue: 'Nike', effectiveValue: { stringValue: 'Nike' } }
    if (h === 'Project Name') return { formattedValue: 'S', effectiveValue: { stringValue: 'S' } }
    return {}
  })
}
const ROW_HASH = sourceRowHash(normalizeRow(MASTER_HEADERS, cells()))

function binding(over: Partial<BindingRow> = {}): BindingRow {
  return {
    id: 'b', project_id: 'p1', spreadsheet_id: 'sid', sheet_id: 0,
    row_metadata_id: 1, source_template_file_id: 'F', source_template_hash: 'h',
    template_markdown: TEMPLATE, canvas_id: 'C1', canvas_url: null,
    creation_state: 'connected', sync_status: 'synced', last_row_hash: ROW_HASH,
    last_synced_at: null, error: null, error_notified_key: null,
    created_at: 't', updated_at: 't', ...over,
  }
}

interface FakeSyncStore {
  bindings: BindingRow[]
  state: SyncStateRow
  notified: Map<string, string>
  advanced: string | null
  claimHolders: string[]
  releaseHolders: string[]
  listSyncableBindings(): Promise<BindingRow[]>
  updateBinding(pid: string, patch: Partial<BindingRow>): Promise<void>
  getSyncState(): Promise<SyncStateRow | null>
  claimWorkbookLease(s: string, k: 'creation' | 'sync', holder: string): Promise<boolean>
  renewWorkbookLease(s: string, k: 'creation' | 'sync', holder: string): Promise<boolean>
  releaseWorkbookLease(s: string, k: 'creation' | 'sync', holder: string): Promise<void>
  advanceCursor(s: string, v: string): Promise<void>
  claimNotification(pid: string, key: string): Promise<boolean>
}

function syncState(driveVersion: string | null): SyncStateRow {
  return {
    spreadsheet_id: 'sid', drive_version: driveVersion, cursor_advanced_at: null,
    creation_lease_holder: null, creation_lease_expires_at: null, creation_fence: 0,
    sync_lease_holder: null, sync_lease_expires_at: null, sync_fence: 0,
  }
}

function makeDeps(over: { bindings?: BindingRow[]; cursor?: string | null; versions?: string[]; metaMissing?: boolean; metaWrongSheet?: boolean; readThrows?: boolean; editThrows?: boolean } = {}): { deps: SyncDeps; edits: string[]; posts: string[]; store: FakeSyncStore } {
  const edits: string[] = []
  const posts: string[] = []
  const versionQueue = [...(over.versions ?? ['v2', 'v2'])]
  const store: FakeSyncStore = {
    bindings: over.bindings ?? [binding({ last_row_hash: 'old' })],
    state: syncState(over.cursor ?? 'v1'),
    notified: new Map<string, string>(),
    advanced: null,
    claimHolders: [],
    releaseHolders: [],
    async listSyncableBindings() { return this.bindings },
    async updateBinding(pid: string, patch: Partial<BindingRow>) { const b = this.bindings.find((x) => x.project_id === pid); if (b) Object.assign(b, patch) },
    async getSyncState() { return this.state },
    async claimWorkbookLease(_s: string, _k: 'creation' | 'sync', holder: string) { this.claimHolders.push(holder); return true },
    async renewWorkbookLease(_s: string, _k: 'creation' | 'sync', _holder: string) { return true },
    async releaseWorkbookLease(_s: string, _k: 'creation' | 'sync', holder: string) { this.releaseHolders.push(holder) },
    async advanceCursor(_s: string, v: string) { this.advanced = v },
    async claimNotification(pid: string, key: string) { if (this.notified.get(pid) === key) return false; this.notified.set(pid, key); return true },
  }
  const deps: SyncDeps = {
    sheets: {
      getWorkbookVersion: async () => versionQueue.shift() ?? 'v2',
      // The real searchRowMetadata THROWS when the id matches only on another
      // sheet; the fake models that. metaMissing → null (genuinely unbound).
      searchRowMetadata: async (_s: string, _p: string, sheetId: number) => {
        if (over.metaWrongSheet) throw new Error(`row metadata for p1 found on sheet(s) 999, not the configured sheet ${sheetId}`)
        return over.metaMissing ? null : { metadataId: 1, rowIndex: 5, sheetId }
      },
      readRow: async () => { if (over.readThrows) throw new Error('configured sheet 0 not found'); return cells() },
    },
    canvas: { editControlCanvas: async (o) => { if (over.editThrows) throw new Error('edit failed'); edits.push(o.canvasId) } },
    store,
    post: async (t: string) => { posts.push(t) },
    config: CONFIG,
    enabled: true,
    now: () => 't',
    sleep: async () => {},
    perBindingDelayMs: 0,
  }
  return { deps, edits, posts, store }
}

describe('runProjectControlSync', () => {
  it('edits only the changed row’s bound canvas', async () => {
    const { deps, edits, store } = makeDeps({
      bindings: [binding({ project_id: 'p1', canvas_id: 'C1', last_row_hash: 'old' }), binding({ project_id: 'p2', canvas_id: 'C2', last_row_hash: ROW_HASH })],
    })
    await runProjectControlSync(deps)
    assert.deepEqual(edits, ['C1'])
    assert.equal(store.advanced, 'v2')
  })

  it('unchanged hash produces no canvas write', async () => {
    const { deps, edits } = makeDeps({ cursor: 'old', versions: ['v2', 'v2'], bindings: [binding({ last_row_hash: ROW_HASH })] })
    const r = await runProjectControlSync(deps)
    assert.deepEqual(edits, [])
    assert.equal(r.unchanged, 1)
  })

  it('processes an error binding even when the Drive version is unchanged', async () => {
    const { deps, edits } = makeDeps({ cursor: 'v1', versions: ['v1', 'v1'], bindings: [binding({ sync_status: 'error', last_row_hash: 'old' })] })
    await runProjectControlSync(deps)
    assert.deepEqual(edits, ['C1'])
  })

  it('syncs generated RF Production views without a legacy template snapshot', async () => {
    const { deps, edits, store } = makeDeps({
      bindings: [binding({ template_markdown: null, source_template_file_id: null, source_template_hash: null, last_row_hash: 'old' })],
    })
    deps.config = { ...CONFIG, layout: 'rf-production-v1' }
    deps.sheets.readProjectSupplement = async () => ({
      scheduleStatus: 'Draft', specs: {}, workback: [], links: [], deliverables: [], assignments: [],
    })

    const result = await runProjectControlSync(deps)

    assert.deepEqual(edits, ['C1'])
    assert.equal(result.updated, 1)
    assert.equal(store.bindings[0].sync_status, 'synced')
    assert.equal(store.bindings[0].error, null)
  })

  it('does not advance the cursor when a binding fails', async () => {
    const { deps, store } = makeDeps({ editThrows: true })
    await runProjectControlSync(deps)
    assert.equal(store.advanced, null)
  })

  it('does not advance the cursor when V1 != V2', async () => {
    const { deps, store } = makeDeps({ versions: ['v2', 'v3'] })
    await runProjectControlSync(deps)
    assert.equal(store.advanced, null)
  })

  it('marks a binding orphaned when its metadata row is missing', async () => {
    const { deps, store, posts } = makeDeps({ metaMissing: true })
    await runProjectControlSync(deps)
    assert.equal(store.bindings[0].sync_status, 'orphaned')
    assert.equal(store.advanced, null)
    assert.equal(posts.length, 1)
  })

  it('rejects metadata found on ANOTHER sheet: error, no canvas edit, cursor not advanced', async () => {
    const { deps, edits, store, posts } = makeDeps({ metaWrongSheet: true })
    await runProjectControlSync(deps)
    assert.deepEqual(edits, []) // never renders a row from the wrong tab
    assert.equal(store.bindings[0].sync_status, 'error')
    assert.match(store.bindings[0].error || '', /not the configured sheet/)
    assert.equal(store.advanced, null)
    assert.equal(posts.length, 1) // surfaced visibly
  })

  it('makes no canvas edit when the configured-sheet row read fails closed', async () => {
    const { deps, edits, store } = makeDeps({ readThrows: true })
    await runProjectControlSync(deps)
    assert.deepEqual(edits, [])
    assert.equal(store.bindings[0].sync_status, 'error')
    assert.equal(store.advanced, null)
  })

  it('emits an error notification only once across runs (deduped)', async () => {
    const { deps, posts } = makeDeps({ editThrows: true })
    await runProjectControlSync(deps)
    await runProjectControlSync(deps)
    assert.equal(posts.length, 1)
  })

  it('emits a recovery notification once when a broken binding syncs', async () => {
    const { deps, posts, store } = makeDeps({ cursor: 'v1', versions: ['v1', 'v1'], bindings: [binding({ sync_status: 'error', last_row_hash: 'old' })] })
    await runProjectControlSync(deps)
    assert.equal(store.bindings[0].sync_status, 'synced')
    assert.equal(posts.filter((p) => p.includes('recovered')).length, 1)
  })

  it('uses a unique sync lease holder per run, retained for release', async () => {
    const { deps, store } = makeDeps()
    await runProjectControlSync(deps)
    await runProjectControlSync(deps)
    assert.equal(store.claimHolders.length, 2)
    assert.notEqual(store.claimHolders[0], store.claimHolders[1]) // unique per run
    assert.ok(store.claimHolders[0].startsWith('sync:'))
    assert.deepEqual(store.claimHolders, store.releaseHolders) // exact token released
  })
})

describe('projectControlSync functions — cron + event share ONE core', () => {
  const cron = projectControlSync as unknown as { opts: any; fn: (...a: any[]) => Promise<unknown> }
  const onEdit = projectControlSyncOnEdit as unknown as { opts: any; fn: (...a: any[]) => Promise<unknown> }

  it('cron is a 10-minute schedule', () => {
    assert.equal(cron.opts.id, 'project-control-sync')
    assert.deepEqual(cron.opts.triggers, [{ cron: '*/10 * * * *' }])
  })

  it('on-edit is triggered by the named event, debounced per workbook AND idempotent per request', () => {
    assert.equal(onEdit.opts.id, 'project-control-sync-on-edit')
    assert.deepEqual(onEdit.opts.triggers, [{ event: 'project-control/sheet.edited' }])
    // Debounce (trailing edge) coalesces DISTINCT bursts but never drops the
    // final edit. Keyed on the workbook.
    assert.equal(onEdit.opts.debounce.key, 'event.data.spreadsheet_id')
    assert.ok(onEdit.opts.debounce.period, 'has a debounce period')
    // Function-level idempotency dedupes REPLAYED notifications — the event-level
    // `id` does NOT dedupe a debounced function, so this is what actually
    // collapses a retried requestId to one run.
    assert.equal(onEdit.opts.idempotency, 'event.data.request_id')
  })

  it('both handlers are the IDENTICAL thin wrapper (no second sync implementation)', () => {
    // Same source ⇒ the event-triggered run and cron-triggered run execute the
    // exact same orchestration (runProjectControlSync).
    assert.equal(cron.fn.toString(), onEdit.fn.toString())
  })

  it('both delegate their work to a single step.run("sync", …)', async () => {
    for (const f of [cron, onEdit]) {
      const ids: string[] = []
      // A fake step that records the id and does NOT execute the callback, so the
      // real (DB-backed) core never runs here — we only prove the wrapper shape.
      const step = { run: (id: string, _cb: () => unknown) => { ids.push(id); return 'SENTINEL' } }
      const out = await f.fn({ step } as any)
      assert.equal(out, 'SENTINEL')
      assert.deepEqual(ids, ['sync'])
    }
  })
})
