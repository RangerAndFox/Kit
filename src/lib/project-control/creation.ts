/**
 * Railway-owned creation orchestration: bind a freshly provisioned project to
 * exactly one Master Project List row and one Project Control Canvas.
 *
 * Creation lifecycle (persisted on the binding, resumable at every step):
 *   pending_sheet → sheet_bound → pending_canvas → connected
 *
 * Every step is idempotent: the Sheet step searches developer metadata before
 * writing; the Canvas step reuses a persisted canvas_id or reconciles by the
 * deterministic title after an ambiguous create. A restart resumes the binding
 * rather than duplicating a row or canvas.
 *
 * All external boundaries are injected (see CreationDeps) so the orchestration
 * is unit-tested with fakes, not only live staging.
 */

import { randomUUID } from 'node:crypto'
import {
  workbookConfigFromEnv,
  projectControlCreationEnabled,
  type WorkbookConfig,
} from './types'
import {
  kitOwnedCreationCells,
  normalizeRow,
  sourceRowHash,
  renderProjectControlCanvas,
  MASTER_HEADERS,
  type SheetCell,
  type OwnedCell,
  type CreationSubmission,
} from './render'
import {
  controlCanvasTitle,
  createControlCanvas,
  editControlCanvas,
  reconcileControlCanvas,
  type CanvasHandle,
  type CanvasReconcile,
} from './canvas'
import {
  searchRowMetadata as realSearchRowMetadata,
  readRow as realReadRow,
  createBoundRow as realCreateBoundRow,
} from './sheets'
import {
  ensureBinding,
  getBindingByProject,
  updateBinding,
  claimWorkbookLease,
  releaseWorkbookLease,
  type BindingRow,
} from './store'

export interface CreationSheetsPort {
  searchRowMetadata(spreadsheetId: string, kitProjectId: string): Promise<{ metadataId: number; rowIndex: number } | null>
  readRow(config: WorkbookConfig, rowIndex: number): Promise<SheetCell[]>
  createBoundRow(
    config: WorkbookConfig,
    kitProjectId: string,
    owned: OwnedCell[],
  ): Promise<{ metadataId: number; rowIndex: number; alreadyBound: boolean }>
}

export interface CreationCanvasPort {
  createControlCanvas(o: { channelId: string; title: string; markdown: string }): Promise<CanvasHandle>
  editControlCanvas(o: { canvasId: string; title: string; markdown: string }): Promise<void>
  reconcileControlCanvas(o: { channelId: string; expectedTitle: string }): Promise<CanvasReconcile>
}

export interface CreationStorePort {
  ensureBinding(o: { projectId: string; spreadsheetId: string; sheetId: number }): Promise<BindingRow>
  getBindingByProject(projectId: string): Promise<BindingRow | null>
  updateBinding(projectId: string, patch: Partial<BindingRow>): Promise<void>
  claimWorkbookLease(spreadsheetId: string, kind: 'creation' | 'sync', holder: string): Promise<boolean>
  releaseWorkbookLease(spreadsheetId: string, kind: 'creation' | 'sync', holder: string): Promise<void>
}

export interface CreationDeps {
  sheets: CreationSheetsPort
  canvas: CreationCanvasPort
  store: CreationStorePort
  config: WorkbookConfig | null
  enabled: boolean
  now: () => string
  /** Injectable delay (for testing the lease retry without real time). */
  sleep?: (ms: number) => Promise<void>
}

// The creation lease serializes Sheet-row writes for a workbook. It is held for
// one binding (a couple of Sheets/Slack calls), so a concurrent creation retries
// briefly rather than being stranded. Single Railway process → seconds, not
// minutes.
const CREATION_LEASE_ATTEMPTS = 20
const CREATION_LEASE_DELAY_MS = 500

export function defaultCreationDeps(): CreationDeps {
  return {
    sheets: {
      searchRowMetadata: realSearchRowMetadata,
      readRow: realReadRow,
      createBoundRow: realCreateBoundRow,
    },
    canvas: { createControlCanvas, editControlCanvas, reconcileControlCanvas },
    store: { ensureBinding, getBindingByProject, updateBinding, claimWorkbookLease, releaseWorkbookLease },
    config: workbookConfigFromEnv(),
    enabled: projectControlCreationEnabled(),
    now: () => new Date().toISOString(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  }
}

export interface BindResult {
  status: 'skipped' | 'connected' | 'error' | 'deferred'
  reason?: string
}

// The Slack agent's provision result carries the resolved control template.
export interface SlackProvisionResult {
  id?: string
  data?: {
    channelId?: string
    controlTemplate?: { fileId: string; markdown: string; hash: string } | null
    controlTemplateError?: string | null
  }
}

export async function bindProjectControl(
  opts: { projectId: string; submission: CreationSubmission; slackResult: SlackProvisionResult },
  deps: CreationDeps = defaultCreationDeps(),
): Promise<BindResult> {
  if (!deps.enabled) return { status: 'skipped', reason: 'creation_disabled' }
  const config = deps.config
  if (!config) return { status: 'skipped', reason: 'workbook_not_configured' }

  const channelId = opts.slackResult?.id || opts.slackResult?.data?.channelId
  if (!channelId) return { status: 'error', reason: 'no_slack_channel' }

  const controlTemplate = opts.slackResult?.data?.controlTemplate || null
  const controlTemplateError = opts.slackResult?.data?.controlTemplateError || null

  const binding = await deps.store.ensureBinding({
    projectId: opts.projectId,
    spreadsheetId: config.spreadsheetId,
    sheetId: config.sheetId,
  })

  // Serialize row writes for this workbook — never write without the lease. The
  // holder is unique PER ACQUISITION (observable prefix + random suffix) so a
  // stale worker can never release a lease a newer holder reclaimed. On
  // contention we retry briefly (the lease is held only for one binding); if it
  // is still unavailable the caller surfaces a visible, actionable 'deferred'.
  const holder = `create:${opts.projectId}:${randomUUID()}`
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let leaseAcquired = false
  for (let attempt = 0; attempt < CREATION_LEASE_ATTEMPTS; attempt++) {
    if (await deps.store.claimWorkbookLease(config.spreadsheetId, 'creation', holder)) {
      leaseAcquired = true
      break
    }
    if (attempt < CREATION_LEASE_ATTEMPTS - 1) await sleep(CREATION_LEASE_DELAY_MS)
  }
  if (!leaseAcquired) return { status: 'deferred', reason: 'creation_lease_unavailable' }

  try {
    // ── Step 1: Sheet row + developer-metadata binding ───────────────────────
    let rowIndex: number | undefined
    if (binding.creation_state === 'pending_sheet') {
      const owned = kitOwnedCreationCells(opts.submission)
      const res = await deps.sheets.createBoundRow(config, opts.projectId, owned)
      rowIndex = res.rowIndex
      await deps.store.updateBinding(opts.projectId, {
        row_metadata_id: res.metadataId,
        creation_state: 'sheet_bound',
        error: null,
      })
    }

    // ── Step 2: template snapshot ────────────────────────────────────────────
    if (!controlTemplate) {
      // Fail closed on the Project Control step only — the Sheet row is bound,
      // but we won't fabricate a Canvas or report a false "connected".
      await deps.store.updateBinding(opts.projectId, {
        sync_status: 'error',
        error: `template_unresolved: ${controlTemplateError || 'unknown'}`,
      })
      return { status: 'error', reason: `template_unresolved:${controlTemplateError || 'unknown'}` }
    }

    const cur = await deps.store.getBindingByProject(opts.projectId)
    if (cur && cur.creation_state === 'sheet_bound') {
      await deps.store.updateBinding(opts.projectId, {
        creation_state: 'pending_canvas',
        source_template_file_id: controlTemplate.fileId,
        source_template_hash: controlTemplate.hash,
        template_markdown: controlTemplate.markdown,
      })
    }

    // ── Step 3: render from the authoritative row + create/reconcile canvas ──
    if (rowIndex == null) {
      // Resuming without the just-created index — re-derive from metadata.
      const m = await deps.sheets.searchRowMetadata(config.spreadsheetId, opts.projectId)
      rowIndex = m?.rowIndex
    }
    if (rowIndex == null) {
      await deps.store.updateBinding(opts.projectId, { sync_status: 'error', error: 'row_metadata_missing' })
      return { status: 'error', reason: 'row_metadata_missing' }
    }

    const cells = await deps.sheets.readRow(config, rowIndex)
    const row = normalizeRow(MASTER_HEADERS, cells)
    const rowHash = sourceRowHash(row)
    const spine = [opts.submission.projectNumber, opts.submission.clientName, opts.submission.projectName]
      .filter(Boolean)
      .join('_')
    const title = controlCanvasTitle(spine || opts.submission.projectName || 'Project')
    const markdown = renderProjectControlCanvas(controlTemplate.markdown, row)

    const b2 = await deps.store.getBindingByProject(opts.projectId)
    if (b2 && b2.canvas_id) {
      await deps.canvas.editControlCanvas({ canvasId: b2.canvas_id, title, markdown })
      await deps.store.updateBinding(opts.projectId, {
        creation_state: 'connected',
        sync_status: 'synced',
        last_row_hash: rowHash,
        last_synced_at: deps.now(),
        error: null,
      })
      return { status: 'connected' }
    }

    let canvasHandle: CanvasHandle
    try {
      canvasHandle = await deps.canvas.createControlCanvas({ channelId, title, markdown })
    } catch (err) {
      // Ambiguous create — inspect only this project's channel by exact title.
      const rec = await deps.canvas.reconcileControlCanvas({ channelId, expectedTitle: title })
      if (rec.status === 'found') {
        await deps.canvas.editControlCanvas({ canvasId: rec.canvasId, title, markdown })
        canvasHandle = { canvasId: rec.canvasId, canvasUrl: null }
      } else if (rec.status === 'ambiguous') {
        await deps.store.updateBinding(opts.projectId, {
          sync_status: 'error',
          error: `canvas_ambiguous: ${rec.canvasIds.join(',')}`,
        })
        return { status: 'error', reason: 'canvas_ambiguous' }
      } else {
        await deps.store.updateBinding(opts.projectId, {
          sync_status: 'error',
          error: `canvas_create_failed: ${(err as Error).message}`,
        })
        return { status: 'error', reason: 'canvas_create_failed' }
      }
    }

    await deps.store.updateBinding(opts.projectId, {
      canvas_id: canvasHandle.canvasId,
      canvas_url: canvasHandle.canvasUrl,
      creation_state: 'connected',
      sync_status: 'synced',
      last_row_hash: rowHash,
      last_synced_at: deps.now(),
      error: null,
    })
    return { status: 'connected' }
  } catch (err) {
    await deps.store
      .updateBinding(opts.projectId, { sync_status: 'error', error: `bind_failed: ${(err as Error).message}` })
      .catch(() => {})
    return { status: 'error', reason: (err as Error).message }
  } finally {
    await deps.store.releaseWorkbookLease(config.spreadsheetId, 'creation', holder).catch(() => {})
  }
}
