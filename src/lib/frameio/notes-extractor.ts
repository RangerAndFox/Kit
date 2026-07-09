// @ts-nocheck
/**
 * Frame.io Notes Extractor
 *
 * Takes a Frame.io review link or asset ID, fetches all comments,
 * attempts to grab frame thumbnails at each timecode, and builds
 * an Excel spreadsheet with embedded images.
 *
 * Pipeline:
 *   URL → resolve assets → fetch comments → fetch thumbnails → build xlsx → Buffer
 */

import {
  detectFrameIoLink,
  resolveShortLink,
  getReviewLinkAssets,
  getAsset,
  getAssetComments,
  getFrameAtTimecode,
  downloadImage,
  formatTimecode,
  type FrameIoComment,
  type FrameIoAsset,
} from './client'

export interface NoteRow {
  index: number
  timecode: string
  timecodeSeconds: number | null
  note: string
  author: string
  authorEmail: string
  date: string
  completed: boolean
  thumbnailBuffer: Buffer | null
}

export interface ExtractionResult {
  assetName: string
  assetId: string
  notes: NoteRow[]
  xlsxBuffer: Buffer
  totalComments: number
  thumbnailsFound: number
}

/**
 * Main entry point: extract notes from a Frame.io URL.
 * Returns the xlsx file as a Buffer ready for Slack upload.
 */
export async function extractFrameIoNotes(url: string): Promise<ExtractionResult> {
  let link = detectFrameIoLink(url)
  if (!link) {
    throw new Error('Could not parse Frame.io URL. Expected a review, player, or short link.')
  }

  // If it's a short link (f.io/xxx), resolve it to a full URL first
  if (link.type === 'short') {
    console.log('[FrameIO] Resolving short link:', link.url)
    const resolved = await resolveShortLink(link.url)
    if (!resolved) {
      throw new Error(`Could not resolve short link: ${link.url}`)
    }
    link = resolved
  }

  // Resolve to asset(s)
  let assets: FrameIoAsset[]
  if (link.type === 'review') {
    assets = await getReviewLinkAssets(link.id)
    if (assets.length === 0) {
      throw new Error('Review link has no assets.')
    }
  } else {
    const asset = await getAsset(link.id)
    assets = [asset]
  }

  // For now, process the first video asset
  const videoAsset = assets.find(a => a.type === 'file' || a.duration) || assets[0]

  // Fetch comments
  const comments = await getAssetComments(videoAsset.id)
  if (comments.length === 0) {
    throw new Error(`No comments found on "${videoAsset.name}".`)
  }

  // Sort by timecode (null timecodes go to end)
  comments.sort((a, b) => {
    if (a.timestamp === null && b.timestamp === null) return 0
    if (a.timestamp === null) return 1
    if (b.timestamp === null) return -1
    return a.timestamp - b.timestamp
  })

  // Frame.io v4 doesn't expose per-timecode frame extraction — every
  // "thumbnail" is the asset's poster frame. Fetch it ONCE and reuse it:
  // the old per-comment loop issued N identical asset fetches + N identical
  // image downloads for an 80-comment review, and reported them as N
  // distinct timecode captures.
  let posterBuffer: Buffer | null = null
  try {
    const frame = await getFrameAtTimecode(videoAsset.id, 0)
    if (frame?.url) {
      posterBuffer = await downloadImage(frame.url)
    }
  } catch {
    // Poster fetch failed — continue without thumbnails
  }

  const notes: NoteRow[] = comments.map((comment, i) => ({
    index: i + 1,
    timecode: comment.timestamp !== null ? formatTimecode(comment.timestamp) : 'General',
    timecodeSeconds: comment.timestamp,
    note: comment.text,
    author: comment.ownerName,
    authorEmail: comment.ownerEmail,
    date: comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : '',
    completed: comment.completed,
    thumbnailBuffer: comment.timestamp !== null ? posterBuffer : null,
  }))

  // Honest accounting: this is ONE poster frame reused across rows, not
  // per-timecode captures.
  const thumbnailsFound = posterBuffer ? 1 : 0

  // Build the xlsx
  const xlsxBuffer = await buildNotesXlsx(videoAsset.name, notes)

  return {
    assetName: videoAsset.name,
    assetId: videoAsset.id,
    notes,
    xlsxBuffer,
    totalComments: comments.length,
    thumbnailsFound,
  }
}

/**
 * Build the Excel spreadsheet using openpyxl via a Python subprocess.
 * We shell out to Python because openpyxl's image embedding is far more
 * reliable than any JS xlsx library for embedded images.
 */
async function buildNotesXlsx(
  assetName: string,
  notes: NoteRow[]
): Promise<Buffer> {
  const { writeFile, readFile, mkdtemp, rm } = await import('fs/promises')
  const { join } = await import('path')
  const { tmpdir } = await import('os')
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  // Create temp directory for images and data
  const tmpDir = await mkdtemp(join(tmpdir(), 'kit-frameio-'))
  const dataPath = join(tmpDir, 'notes.json')
  const outputPath = join(tmpDir, 'notes.xlsx')

  try {
    // Save thumbnail images and prepare data
    const rows = await Promise.all(
      notes.map(async (note) => {
        let imagePath: string | null = null
        if (note.thumbnailBuffer) {
          imagePath = join(tmpDir, `thumb_${note.index}.png`)
          await writeFile(imagePath, note.thumbnailBuffer)
        }
        return {
          index: note.index,
          timecode: note.timecode,
          timecodeSeconds: note.timecodeSeconds,
          note: note.note,
          author: note.author,
          authorEmail: note.authorEmail,
          date: note.date,
          completed: note.completed,
          imagePath,
        }
      })
    )

    // Write data JSON for the Python script
    await writeFile(dataPath, JSON.stringify({ assetName, rows }, null, 2))

    // Write the Python script inline
    const pyScript = join(tmpDir, 'build_xlsx.py')
    await writeFile(pyScript, PYTHON_XLSX_SCRIPT)

    // Execute Python
    await execFileAsync('python3', [pyScript, dataPath, outputPath], {
      timeout: 30_000,
    })

    // Read the generated xlsx
    const xlsxBuffer = await readFile(outputPath)
    return xlsxBuffer
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── Python Script for XLSX Generation ──────────────────────

const PYTHON_XLSX_SCRIPT = `
import json, sys
from pathlib import Path

try:
    from openpyxl import Workbook
    from openpyxl.drawing.image import Image as XlImage
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "Pillow", "-q"])
    from openpyxl import Workbook
    from openpyxl.drawing.image import Image as XlImage
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

data_path = sys.argv[1]
output_path = sys.argv[2]

with open(data_path) as f:
    data = json.load(f)

asset_name = data["assetName"]
rows = data["rows"]

wb = Workbook()
ws = wb.active
ws.title = "Review Notes"

# ─── Styles ──────────────────────────────────────────────
header_font = Font(name="Arial", bold=True, color="FFFFFF", size=11)
header_fill = PatternFill("solid", fgColor="2D2D2D")
header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

data_font = Font(name="Arial", size=10)
data_align = Alignment(vertical="top", wrap_text=True)
completed_font = Font(name="Arial", size=10, strikethrough=True, color="999999")

thin_border = Border(
    left=Side(style="thin", color="CCCCCC"),
    right=Side(style="thin", color="CCCCCC"),
    top=Side(style="thin", color="CCCCCC"),
    bottom=Side(style="thin", color="CCCCCC"),
)

alt_fill = PatternFill("solid", fgColor="F7F7F7")

# ─── Title Row ───────────────────────────────────────────
ws.merge_cells("A1:F1")
title_cell = ws["A1"]
title_cell.value = f"Review Notes — {asset_name}"
title_cell.font = Font(name="Arial", bold=True, size=14)
title_cell.alignment = Alignment(vertical="center")
ws.row_dimensions[1].height = 35

# ─── Headers ─────────────────────────────────────────────
headers = ["#", "Thumbnail", "Timecode", "Note", "From", "Date"]
col_widths = [5, 22, 14, 55, 18, 12]

for col_idx, (hdr, width) in enumerate(zip(headers, col_widths), 1):
    cell = ws.cell(row=2, column=col_idx, value=hdr)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = header_align
    cell.border = thin_border
    ws.column_dimensions[get_column_letter(col_idx)].width = width

ws.row_dimensions[2].height = 28

# ─── Data Rows ───────────────────────────────────────────
THUMB_HEIGHT = 80   # pixels
ROW_HEIGHT = 68     # Excel row height points (~90px)

for i, row in enumerate(rows):
    r = i + 3  # data starts at row 3
    is_alt = i % 2 == 1
    is_done = row.get("completed", False)
    font = completed_font if is_done else data_font
    fill = alt_fill if is_alt else PatternFill()

    # # column
    cell = ws.cell(row=r, column=1, value=row["index"])
    cell.font = font
    cell.fill = fill
    cell.alignment = Alignment(horizontal="center", vertical="top")
    cell.border = thin_border

    # Thumbnail column (images added after)
    thumb_cell = ws.cell(row=r, column=2, value="")
    thumb_cell.fill = fill
    thumb_cell.border = thin_border

    # Timecode
    cell = ws.cell(row=r, column=3, value=row["timecode"])
    cell.font = Font(name="Courier New", size=10, strikethrough=is_done, color="999999" if is_done else "000000")
    cell.fill = fill
    cell.alignment = Alignment(horizontal="center", vertical="top")
    cell.border = thin_border

    # Note
    cell = ws.cell(row=r, column=4, value=row["note"])
    cell.font = font
    cell.fill = fill
    cell.alignment = data_align
    cell.border = thin_border

    # Author
    cell = ws.cell(row=r, column=5, value=row["author"])
    cell.font = font
    cell.fill = fill
    cell.alignment = Alignment(vertical="top")
    cell.border = thin_border

    # Date
    cell = ws.cell(row=r, column=6, value=row["date"])
    cell.font = font
    cell.fill = fill
    cell.alignment = Alignment(horizontal="center", vertical="top")
    cell.border = thin_border

    # Set row height for thumbnail
    ws.row_dimensions[r].height = ROW_HEIGHT

    # Add thumbnail image if available
    img_path = row.get("imagePath")
    if img_path and Path(img_path).exists():
        try:
            img = XlImage(img_path)
            # Scale to fit: max width ~150px, height ~80px
            aspect = img.width / img.height if img.height > 0 else 16/9
            img.height = THUMB_HEIGHT
            img.width = int(THUMB_HEIGHT * aspect)
            if img.width > 150:
                img.width = 150
                img.height = int(150 / aspect)
            anchor = f"B{r}"
            ws.add_image(img, anchor)
        except Exception as e:
            ws.cell(row=r, column=2, value=f"[img error: {e}]")

# ─── Summary row ─────────────────────────────────────────
summary_row = len(rows) + 3
ws.cell(row=summary_row, column=1).value = ""
ws.cell(row=summary_row + 1, column=3, value="Total notes:").font = Font(name="Arial", bold=True, size=10)
ws.cell(row=summary_row + 1, column=4, value=len(rows)).font = Font(name="Arial", size=10)

completed_count = sum(1 for r in rows if r.get("completed"))
if completed_count > 0:
    ws.cell(row=summary_row + 2, column=3, value="Completed:").font = Font(name="Arial", bold=True, size=10)
    ws.cell(row=summary_row + 2, column=4, value=completed_count).font = Font(name="Arial", size=10)

# ─── Freeze panes & print settings ──────────────────────
ws.freeze_panes = "A3"
ws.print_title_rows = "1:2"
ws.sheet_properties.pageSetUpPr.fitToPage = True

wb.save(output_path)
print(json.dumps({"ok": True, "rows": len(rows)}))
`
