/**
 * Operator utility: repair legacy Frame.io project URLs in the Master Project
 * List, dry-run FIRST.
 *
 * It inspects ONLY the Frame.io column (R). It matches ONLY the exact known
 * legacy browser shape:
 *     https://app.frame.io/projects/{id}
 * and proposes the canonical current shape (same id, preserved exactly):
 *     https://next.frame.io/project/{id}
 *
 * It never rewrites arbitrary Frame.io links (reviews/shares/player), the
 * already-correct next.frame.io form, or any non-matching value; it never
 * touches margin/formula or other columns. It is idempotent (a second run finds
 * nothing). Writes require an explicit --apply flag; the default is a dry run.
 *
 * Auth/config reuse the existing Project Control Google service-account path
 * (src/lib/project-control/sheets.ts + workbookConfigFromEnv). After an
 * authorised repair, the normal Sheet→Canvas sync propagates the corrected URL
 * to the same canvases — do NOT add a second Canvas repair.
 *
 * Usage (run from repo root, with the production Google env configured):
 *     npx tsx scripts/project-control/repair-frameio-urls.ts            # dry run
 *     npx tsx scripts/project-control/repair-frameio-urls.ts --apply    # writes
 *
 * DO NOT run against production without explicit authorization.
 */

import { frameioProjectUrl } from '../../src/lib/frameio/url'
import { workbookConfigFromEnv } from '../../src/lib/project-control/types'
import { readColumn, writeCellValue, type ColumnCell } from '../../src/lib/project-control/sheets'

const FRAMEIO_HEADER = 'Frame.io'

/** The EXACT legacy shape, anchored — no trailing path, query, or fragment. */
export const LEGACY_FRAMEIO_PROJECT_URL = /^https:\/\/app\.frame\.io\/projects\/([^/?#\s]+)$/

export interface FrameioUrlRepair {
  /** 1-based sheet row number (for the operator report). */
  rowNumber: number
  /** 0-based grid row index (for the write). */
  rowIndex: number
  oldUrl: string
  newUrl: string
}

/**
 * Pure planner: given the Frame.io column cells, return the exact set of legacy
 * URLs to repair. Non-matching values (arbitrary links, blanks, the already
 * correct next.frame.io form) are skipped. The project id is preserved verbatim.
 */
export function planFrameioUrlRepairs(cells: ColumnCell[]): FrameioUrlRepair[] {
  const out: FrameioUrlRepair[] = []
  for (const c of cells) {
    const m = LEGACY_FRAMEIO_PROJECT_URL.exec((c.value || '').trim())
    if (!m) continue
    const id = m[1]
    const newUrl = frameioProjectUrl(id)
    if (newUrl === c.value.trim()) continue // already correct (defensive; won't match legacy anyway)
    out.push({ rowNumber: c.rowIndex + 1, rowIndex: c.rowIndex, oldUrl: c.value.trim(), newUrl })
  }
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const config = workbookConfigFromEnv()
  if (!config) {
    console.error('[repair] REFUSING: workbook not configured (set MASTER_PROJECT_LIST_SPREADSHEET_ID + _SHEET_ID).')
    process.exitCode = 1
    return
  }

  console.log(`[repair] Frame.io URL repair — mode: ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`)
  console.log(`[repair] workbook=${config.spreadsheetId} sheet=${config.sheetId} column=${FRAMEIO_HEADER}`)

  const cells = await readColumn(config, FRAMEIO_HEADER)
  const repairs = planFrameioUrlRepairs(cells)

  if (repairs.length === 0) {
    console.log('[repair] No legacy https://app.frame.io/projects/{id} values found. Nothing to do.')
    return
  }

  console.log(`[repair] ${repairs.length} legacy URL(s) ${apply ? 'to rewrite' : 'would be rewritten'}:`)
  for (const r of repairs) {
    console.log(`  Row ${r.rowNumber}: ${r.oldUrl}  ->  ${r.newUrl}`)
  }

  if (!apply) {
    console.log('[repair] DRY RUN complete — no cells written. Re-run with --apply to write (requires authorization).')
    return
  }

  let written = 0
  for (const r of repairs) {
    await writeCellValue(config, r.rowIndex, FRAMEIO_HEADER, r.newUrl)
    written++
    console.log(`  [applied] Row ${r.rowNumber} → ${r.newUrl}`)
  }
  console.log(`[repair] APPLIED ${written}/${repairs.length}. The Sheet→Canvas sync will propagate corrected URLs.`)
}

// Only run when executed directly (so tests can import the pure planner).
const invokedDirectly = process.argv[1] && /repair-frameio-urls\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[repair] FAILED:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
