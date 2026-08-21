/**
 * Shared Project Control types + workbook configuration.
 *
 * Mirrors the durable state added in migration 056. The Master Project List is
 * authoritative; the Canvas is a one-way rendered view.
 */

export const KIT_PROJECT_ID_METADATA_KEY = 'kit_project_id'

/** Creation lifecycle (Railway-owned). */
export type CreationState = 'pending_sheet' | 'sheet_bound' | 'pending_canvas' | 'connected'

/** Sync lifecycle (Vercel/Inngest-owned). */
export type SyncStatus = 'pending' | 'synced' | 'error' | 'orphaned'

export type CreationRequestStatus =
  | 'pending'
  | 'awaiting_decision'
  | 'provisioning'
  | 'completed'
  | 'error'
  // Terminal user cancel. Distinct from 'error' so the Railway recovery sweep
  // never resumes a request the user explicitly cancelled.
  | 'cancelled'

export type CreationDecision = 'create' | 'duplicate' | 'replace'

export interface WorkbookConfig {
  spreadsheetId: string
  sheetId: number
  /** 1-based Projects header row. */
  headerRow: number
  /** Physical workbook schema. Omitted/legacy preserves the original A:Y sheet. */
  layout?: 'legacy' | 'rf-production-v1'
  /** Numeric gid of the normalized Links tab used by rf-production-v1. */
  linksSheetId?: number
  /** 1-based Links header row; defaults to headerRow. */
  linksHeaderRow?: number
  /** Optional explicit Project Control template file id (SLACK override). */
  controlTemplateFileId?: string
  /** Template channel used when no explicit file ids are configured. */
  templateChannelId: string
}

export function workbookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkbookConfig | null {
  const spreadsheetId = env.MASTER_PROJECT_LIST_SPREADSHEET_ID?.trim()
  const sheetIdRaw = env.MASTER_PROJECT_LIST_SHEET_ID?.trim()
  if (!spreadsheetId || !sheetIdRaw) return null
  return {
    spreadsheetId,
    sheetId: parseInt(sheetIdRaw, 10),
    headerRow: env.MASTER_PROJECT_LIST_HEADER_ROW ? parseInt(env.MASTER_PROJECT_LIST_HEADER_ROW, 10) : 3,
    layout: env.MASTER_PROJECT_LIST_LAYOUT === 'rf-production-v1' ? 'rf-production-v1' : 'legacy',
    linksSheetId: env.MASTER_PROJECT_LIST_LINKS_SHEET_ID
      ? parseInt(env.MASTER_PROJECT_LIST_LINKS_SHEET_ID, 10)
      : undefined,
    linksHeaderRow: env.MASTER_PROJECT_LIST_LINKS_HEADER_ROW
      ? parseInt(env.MASTER_PROJECT_LIST_LINKS_HEADER_ROW, 10)
      : undefined,
    controlTemplateFileId: env.SLACK_PROJECT_CONTROL_TEMPLATE_FILE_ID?.trim() || undefined,
    templateChannelId: env.SLACK_TEMPLATE_CHANNEL_ID?.trim() || 'C0B1312H89L',
  }
}

export function projectControlSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROJECT_CONTROL_SYNC_ENABLED === 'true'
}

/**
 * Independent creation-side gate. When false, new-project provisioning behaves
 * exactly as it did before this mission: no Sheet row, no binding, no managed
 * Canvas, no exclusion from generic cloning. Separate from the sync gate.
 */
export function projectControlCreationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROJECT_CONTROL_CREATION_ENABLED === 'true'
}

export interface ProjectControlBinding {
  id: string
  project_id: string
  spreadsheet_id: string
  sheet_id: number
  row_metadata_id: number | null
  source_template_file_id: string | null
  source_template_hash: string | null
  template_markdown: string | null
  canvas_id: string | null
  canvas_url: string | null
  creation_state: CreationState
  sync_status: SyncStatus
  last_row_hash: string | null
  last_synced_at: string | null
  error: string | null
  error_notified_key: string | null
  created_at: string
  updated_at: string
}
