/**
 * Railway-owned creation orchestration: bind a freshly provisioned project to
 * exactly one Projects row, its normalized child records, and three Project
 * Control canvases.
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
  upsertProjectLinks as realUpsertProjectLinks,
  seedNormalizedProjectTables as realSeedNormalizedProjectTables,
  readProjectSupplement as realReadProjectSupplement,
  type ProjectLinksInput,
} from './sheets'
import { projectViewHash, renderOverviewView, renderReferenceView, renderScheduleView, type ProjectSupplement } from './views'
import {
  ensureBinding,
  getBindingByProject,
  updateBinding,
  claimWorkbookLease,
  renewWorkbookLease,
  releaseWorkbookLease,
  type BindingRow,
  upsertProjectCanvas,
  listProjectCanvases,
  type ProjectCanvasRow,
} from './store'

export interface CreationSheetsPort {
  searchRowMetadata(spreadsheetId: string, kitProjectId: string, sheetId: number): Promise<{ metadataId: number; rowIndex: number; sheetId: number } | null>
  readRow(config: WorkbookConfig, rowIndex: number): Promise<SheetCell[]>
  createBoundRow(
    config: WorkbookConfig,
    kitProjectId: string,
    owned: OwnedCell[],
  ): Promise<{ metadataId: number; rowIndex: number; alreadyBound: boolean }>
  upsertProjectLinks(config: WorkbookConfig, projectNumber: string | undefined, links: ProjectLinksInput): Promise<void>
  seedNormalizedProjectTables?(config: WorkbookConfig, submission: CreationSubmission): Promise<void>
  readProjectSupplement?(config: WorkbookConfig, projectNumber: string): Promise<ProjectSupplement>
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
  renewWorkbookLease(spreadsheetId: string, kind: 'creation' | 'sync', holder: string): Promise<boolean>
  releaseWorkbookLease(spreadsheetId: string, kind: 'creation' | 'sync', holder: string): Promise<void>
  upsertProjectCanvas?(input: { projectId: string; canvasType: 'overview' | 'reference' | 'schedule'; canvasId: string; canvasUrl?: string | null; sourceTemplateFileId?: string | null; templateMarkdown?: string | null; sourceTemplateHash?: string | null }): Promise<void>
  listProjectCanvases?(projectId: string): Promise<ProjectCanvasRow[]>
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
      upsertProjectLinks: realUpsertProjectLinks,
      seedNormalizedProjectTables: realSeedNormalizedProjectTables,
      readProjectSupplement: realReadProjectSupplement,
    },
    canvas: { createControlCanvas, editControlCanvas, reconcileControlCanvas },
    store: {
      ensureBinding, getBindingByProject, updateBinding,
      claimWorkbookLease, renewWorkbookLease, releaseWorkbookLease,
      upsertProjectCanvas,
      listProjectCanvases,
    },
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
    canvasClones?: Array<{ templateFileId: string; canvasId: string; title: string; markdown: string }>
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
  const saveCanvasBindings = async (overview: CanvasHandle) => {
    if (!deps.store.upsertProjectCanvas) return
    await deps.store.upsertProjectCanvas({ projectId: opts.projectId, canvasType: 'overview', canvasId: overview.canvasId, canvasUrl: overview.canvasUrl, sourceTemplateFileId: controlTemplate?.fileId, templateMarkdown: controlTemplate?.markdown, sourceTemplateHash: controlTemplate?.hash })
  }

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
      // Ownership check immediately before the irreversible Sheet write.
      if (!(await deps.store.renewWorkbookLease(config.spreadsheetId, 'creation', holder))) {
        return { status: 'deferred', reason: 'creation_lease_lost' }
      }
      const owned = kitOwnedCreationCells(opts.submission, config.layout || 'legacy')
      const res = await deps.sheets.createBoundRow(config, opts.projectId, owned)
      rowIndex = res.rowIndex
      await deps.store.updateBinding(opts.projectId, {
        row_metadata_id: res.metadataId,
        creation_state: 'sheet_bound',
        error: null,
      })
    }

    // The RF Production workbook normalizes provider URLs into its Links tab.
    // This runs on every resume: an interrupted write self-heals before Canvas
    // creation, while the upsert prevents duplicate link rows.
    await deps.sheets.upsertProjectLinks(config, opts.submission.projectNumber, {
      frameioUrl: opts.submission.frameioUrl,
      dropboxUrl: opts.submission.dropboxUrl,
      harvestUrl: opts.submission.harvestUrl,
      boordsUrl: opts.submission.boordsUrl,
    })
    await deps.sheets.seedNormalizedProjectTables?.(config, opts.submission)

    // ── Step 2: template snapshot ────────────────────────────────────────────
    const generatedViews = config.layout === 'rf-production-v1' && Boolean(deps.sheets.readProjectSupplement)
    if (!controlTemplate && !generatedViews) {
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
        source_template_file_id: controlTemplate?.fileId || null,
        source_template_hash: controlTemplate?.hash || null,
        template_markdown: controlTemplate?.markdown || null,
      })
    }

    // Heartbeat the lease before the (potentially slow) Slack canvas step. If we
    // lost it — a peer reclaimed it after our lease expired — stop before
    // touching the canvas so we never race a newer holder. Deferred, not error:
    // the newer holder (or the recovery sweep) will complete the binding.
    if (!(await deps.store.renewWorkbookLease(config.spreadsheetId, 'creation', holder))) {
      return { status: 'deferred', reason: 'creation_lease_lost' }
    }

    // ── Step 3: render from the authoritative row + create/reconcile canvas ──
    if (rowIndex == null) {
      // Resuming without the just-created index — re-derive from metadata on the
      // CONFIGURED sheet (a match on another tab throws → bind_failed, never a
      // wrong-tab row index).
      const m = await deps.sheets.searchRowMetadata(config.spreadsheetId, opts.projectId, config.sheetId)
      rowIndex = m?.rowIndex
    }
    if (rowIndex == null) {
      await deps.store.updateBinding(opts.projectId, { sync_status: 'error', error: 'row_metadata_missing' })
      return { status: 'error', reason: 'row_metadata_missing' }
    }

    const cells = await deps.sheets.readRow(config, rowIndex)
    const row = normalizeRow(MASTER_HEADERS, cells)
    const extra = deps.sheets.readProjectSupplement
      ? await deps.sheets.readProjectSupplement(config, row['Project Number']?.display || '')
      : null
    const rowHash = extra ? projectViewHash(row, extra) : sourceRowHash(row)
    const spine = [opts.submission.projectNumber, opts.submission.clientName, opts.submission.projectName]
      .filter(Boolean)
      .join('_')
    const title = controlCanvasTitle(spine || opts.submission.projectName || 'Project')
    const markdown = extra
      ? renderOverviewView(row, extra)
      : renderProjectControlCanvas(controlTemplate!.markdown, row)
    const ensureSupplementalViews = async () => {
      if (!extra) return
      const persisted = deps.store.listProjectCanvases
        ? await deps.store.listProjectCanvases(opts.projectId)
        : []
      const desired = [
        { canvasType: 'reference' as const, label: 'Reference', markdown: renderReferenceView(row, extra) },
        { canvasType: 'schedule' as const, label: 'Schedule', markdown: renderScheduleView(row, extra) },
      ]
      for (const view of desired) {
        const title = `${spine || opts.submission.projectName || 'Project'} — ${view.label}`
        const clone = (opts.slackResult.data?.canvasClones || []).find((candidate) =>
          candidate.title.toLowerCase().includes(view.canvasType))
        const stored = persisted.find((candidate) => candidate.canvas_type === view.canvasType && candidate.canvas_id)
        let handle: CanvasHandle
        if (clone) {
          await deps.canvas.editControlCanvas({ canvasId: clone.canvasId, title, markdown: view.markdown })
          handle = { canvasId: clone.canvasId, canvasUrl: null }
        } else if (stored?.canvas_id) {
          await deps.canvas.editControlCanvas({ canvasId: stored.canvas_id, title, markdown: view.markdown })
          handle = { canvasId: stored.canvas_id, canvasUrl: stored.canvas_url }
        } else {
          try {
            handle = await deps.canvas.createControlCanvas({ channelId, title, markdown: view.markdown })
          } catch (err) {
            const rec = await deps.canvas.reconcileControlCanvas({ channelId, expectedTitle: title })
            if (rec.status === 'found') {
              await deps.canvas.editControlCanvas({ canvasId: rec.canvasId, title, markdown: view.markdown })
              handle = { canvasId: rec.canvasId, canvasUrl: null }
            } else if (rec.status === 'ambiguous') {
              throw new Error(`${view.canvasType}_canvas_ambiguous: ${rec.canvasIds.join(',')}`)
            } else {
              throw err
            }
          }
        }
        await deps.store.upsertProjectCanvas?.({
          projectId: opts.projectId,
          canvasType: view.canvasType,
          canvasId: handle.canvasId,
          canvasUrl: handle.canvasUrl,
          sourceTemplateFileId: clone?.templateFileId || null,
          templateMarkdown: clone?.markdown || null,
        })
      }
    }

    const b2 = await deps.store.getBindingByProject(opts.projectId)
    if (b2 && b2.canvas_id) {
      await deps.canvas.editControlCanvas({ canvasId: b2.canvas_id, title, markdown })
      await saveCanvasBindings({ canvasId: b2.canvas_id, canvasUrl: b2.canvas_url })
      await ensureSupplementalViews()
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

    await saveCanvasBindings(canvasHandle)
    await ensureSupplementalViews()
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
