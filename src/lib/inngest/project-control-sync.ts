/**
 * Project Control one-way synchronization — Inngest cron (Vercel-owned).
 *
 * The Master Project List is authoritative. Each run renders the managed
 * Project Control Canvas from the stored template snapshot + the authoritative
 * normalized Sheet row, editing ONLY each binding's persisted canvas_id.
 *
 * Coarse cursor = the workbook Drive file version; fine change detector = a
 * normalized per-row hash (hyperlink-aware). Recovery work (error/orphaned
 * bindings) runs even when the Drive version is unchanged. The cursor advances
 * only when a full pass succeeds AND the version was stable (V1==V2).
 *
 * All boundaries are injected (SyncDeps) so the orchestration is unit-tested
 * with fakes. Gated on PROJECT_CONTROL_SYNC_ENABLED and a configured workbook.
 */

import { randomUUID } from 'node:crypto'
import { inngest } from './client'
import {
  workbookConfigFromEnv,
  projectControlSyncEnabled,
  type WorkbookConfig,
} from '../project-control/types'
import { getWorkbookVersion, searchRowMetadata, readRow } from '../project-control/sheets'
import { editControlCanvas, controlCanvasTitle } from '../project-control/canvas'
import {
  normalizeRow,
  sourceRowHash,
  renderProjectControlCanvas,
  MASTER_HEADERS,
  type SheetCell,
} from '../project-control/render'
import {
  listSyncableBindings,
  updateBinding,
  getSyncState,
  claimWorkbookLease,
  releaseWorkbookLease,
  advanceCursor,
  claimNotification,
  type BindingRow,
  type SyncStateRow,
} from '../project-control/store'

export interface SyncSheetsPort {
  getWorkbookVersion(spreadsheetId: string): Promise<string>
  searchRowMetadata(spreadsheetId: string, kitProjectId: string): Promise<{ metadataId: number; rowIndex: number } | null>
  readRow(config: WorkbookConfig, rowIndex: number): Promise<SheetCell[]>
}
export interface SyncCanvasPort {
  editControlCanvas(o: { canvasId: string; title: string; markdown: string }): Promise<void>
}
export interface SyncStorePort {
  listSyncableBindings(spreadsheetId: string): Promise<BindingRow[]>
  updateBinding(projectId: string, patch: Partial<BindingRow>): Promise<void>
  getSyncState(spreadsheetId: string): Promise<SyncStateRow | null>
  claimWorkbookLease(spreadsheetId: string, kind: 'creation' | 'sync', holder: string): Promise<boolean>
  releaseWorkbookLease(spreadsheetId: string, kind: 'creation' | 'sync', holder: string): Promise<void>
  advanceCursor(spreadsheetId: string, driveVersion: string): Promise<void>
  claimNotification(projectId: string, key: string): Promise<boolean>
}
export interface SyncDeps {
  sheets: SyncSheetsPort
  canvas: SyncCanvasPort
  store: SyncStorePort
  post: (text: string) => Promise<void>
  config: WorkbookConfig | null
  enabled: boolean
  now: () => string
}

async function postAlert(text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.KIT_PROJECT_CONTROL_ALERT_CHANNEL_ID || process.env.KIT_HEALTH_CHANNEL_ID
  if (!token || !channel) return
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)
}

export function defaultSyncDeps(): SyncDeps {
  return {
    sheets: { getWorkbookVersion, searchRowMetadata, readRow },
    canvas: { editControlCanvas },
    store: {
      listSyncableBindings, updateBinding, getSyncState, claimWorkbookLease,
      releaseWorkbookLease, advanceCursor, claimNotification,
    },
    post: postAlert,
    config: workbookConfigFromEnv(),
    enabled: projectControlSyncEnabled(),
    now: () => new Date().toISOString(),
  }
}

export interface SyncSummary {
  ran: boolean
  reason?: string
  considered: number
  updated: number
  unchanged: number
  orphaned: number
  errored: number
  cursorAdvanced: boolean
}

export async function runProjectControlSync(deps: SyncDeps = defaultSyncDeps()): Promise<SyncSummary> {
  const empty: SyncSummary = {
    ran: false, considered: 0, updated: 0, unchanged: 0, orphaned: 0, errored: 0, cursorAdvanced: false,
  }
  if (!deps.enabled) return { ...empty, reason: 'disabled' }
  const config = deps.config
  if (!config) return { ...empty, reason: 'workbook_not_configured' }

  /** Notify once per transition (persisted dedupe on the binding). */
  const notifyOnce = async (projectId: string, key: string, text: string): Promise<void> => {
    if (await deps.store.claimNotification(projectId, key)) await deps.post(text)
  }

  // Unique holder PER ACQUISITION (observable prefix + random suffix), never a
  // timestamp-only token — so a stale sync worker cannot release a newer holder.
  const holder = `sync:${randomUUID()}`
  if (!(await deps.store.claimWorkbookLease(config.spreadsheetId, 'sync', holder))) {
    return { ...empty, reason: 'sync_lease_unavailable' }
  }

  try {
    const v1 = await deps.sheets.getWorkbookVersion(config.spreadsheetId)
    const state = await deps.store.getSyncState(config.spreadsheetId)
    const cursorVersion = state?.drive_version || null

    const bindings = await deps.store.listSyncableBindings(config.spreadsheetId)
    const needsRecovery = bindings.filter((b) => b.sync_status !== 'synced')

    // Coarse gate: unchanged workbook AND nothing to recover ⇒ cheap exit.
    if (v1 === cursorVersion && needsRecovery.length === 0) {
      return { ...empty, ran: true, reason: 'no_change', considered: bindings.length }
    }

    let updated = 0, unchanged = 0, orphaned = 0, errored = 0
    let allOk = true

    for (const b of bindings) {
      try {
        const meta = await deps.sheets.searchRowMetadata(config.spreadsheetId, b.project_id)
        if (!meta) {
          orphaned++
          allOk = false
          await deps.store.updateBinding(b.project_id, { sync_status: 'orphaned', error: 'row_metadata_missing' })
          await notifyOnce(b.project_id, 'orphaned', `:warning: Project Control: bound Sheet row for project \`${b.project_id}\` is missing — Canvas may be stale.`)
          continue
        }

        const cells = await deps.sheets.readRow(config, meta.rowIndex)
        const row = normalizeRow(MASTER_HEADERS, cells)
        const hash = sourceRowHash(row)

        if (hash === b.last_row_hash && b.sync_status === 'synced') {
          unchanged++
          continue
        }

        if (!b.canvas_id || !b.template_markdown) {
          errored++
          allOk = false
          await deps.store.updateBinding(b.project_id, { sync_status: 'error', error: 'binding_incomplete' })
          await notifyOnce(b.project_id, 'error:binding_incomplete', `:red_circle: Project Control: binding for \`${b.project_id}\` is incomplete (no canvas/template).`)
          continue
        }

        const spine = [row['Project Number']?.display, row['Client']?.display, row['Project Name']?.display]
          .filter(Boolean).join('_')
        const title = controlCanvasTitle(spine || row['Project Name']?.display || 'Project')
        const markdown = renderProjectControlCanvas(b.template_markdown, row)
        await deps.canvas.editControlCanvas({ canvasId: b.canvas_id, title, markdown })

        const wasBroken = b.sync_status === 'error' || b.sync_status === 'orphaned'
        await deps.store.updateBinding(b.project_id, {
          sync_status: 'synced',
          last_row_hash: hash,
          last_synced_at: deps.now(),
          error: null,
        })
        updated++
        if (wasBroken) await notifyOnce(b.project_id, `ok:${hash}`, `:large_green_circle: Project Control: \`${b.project_id}\` recovered and is in sync.`)
      } catch (err) {
        errored++
        allOk = false
        await deps.store.updateBinding(b.project_id, { sync_status: 'error', error: `sync_failed: ${(err as Error).message}` }).catch(() => {})
        await notifyOnce(b.project_id, `error:${String((err as Error).message).slice(0, 40)}`, `:red_circle: Project Control sync failed for \`${b.project_id}\`: ${(err as Error).message}`)
      }
    }

    // Advance the cursor only if EVERYTHING succeeded and the workbook version
    // was stable across the pass.
    const v2 = await deps.sheets.getWorkbookVersion(config.spreadsheetId)
    let cursorAdvanced = false
    if (allOk && v1 === v2) {
      await deps.store.advanceCursor(config.spreadsheetId, v1)
      cursorAdvanced = true
    }

    return { ran: true, considered: bindings.length, updated, unchanged, orphaned, errored, cursorAdvanced }
  } finally {
    await deps.store.releaseWorkbookLease(config.spreadsheetId, 'sync', holder).catch(() => {})
  }
}

export const projectControlSync = inngest.createFunction(
  {
    id: 'project-control-sync',
    name: 'Project Control — Sheet→Canvas sync',
    retries: 1,
    triggers: [{ cron: '*/10 * * * *' }],
  },
  async ({ step }: { step: { run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T> } }) => {
    return step.run('sync', () => runProjectControlSync())
  },
)
