/**
 * runProjectControlSync tests via injected fake ports.
 *
 * Run: npx tsx --test src/lib/project-control/sync.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runProjectControlSync, type SyncDeps } from '../inngest/project-control-sync'
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

function makeDeps(over: { bindings?: BindingRow[]; cursor?: string | null; versions?: string[]; metaMissing?: boolean; editThrows?: boolean } = {}): { deps: SyncDeps; edits: string[]; posts: string[]; store: FakeSyncStore } {
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
    async releaseWorkbookLease(_s: string, _k: 'creation' | 'sync', holder: string) { this.releaseHolders.push(holder) },
    async advanceCursor(_s: string, v: string) { this.advanced = v },
    async claimNotification(pid: string, key: string) { if (this.notified.get(pid) === key) return false; this.notified.set(pid, key); return true },
  }
  const deps: SyncDeps = {
    sheets: {
      getWorkbookVersion: async () => versionQueue.shift() ?? 'v2',
      searchRowMetadata: async () => (over.metaMissing ? null : { metadataId: 1, rowIndex: 5 }),
      readRow: async () => cells(),
    },
    canvas: { editControlCanvas: async (o) => { if (over.editThrows) throw new Error('edit failed'); edits.push(o.canvasId) } },
    store,
    post: async (t: string) => { posts.push(t) },
    config: CONFIG,
    enabled: true,
    now: () => 't',
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
