// @ts-nocheck
/**
 * File ingestion for the storyboard provisioner.
 *
 * Slack-hosted .docx and .txt files arrive on the messages handler with
 * a url_private that requires the bot token to download. We fetch the
 * bytes, run them through mammoth (for docx) or just decode UTF-8 (for
 * txt), and return plain text plus any preserved tables.
 */

/**
 * Download a Slack-hosted file via url_private using the bot token.
 * Returns the raw bytes.
 */
export async function downloadSlackFile(urlPrivate: string): Promise<Buffer> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN not set')
  const res = await fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status} ${res.statusText}`)
  }
  const arrayBuf = await res.arrayBuffer()
  return Buffer.from(arrayBuf)
}

/**
 * Extract plain text from a .docx file. Mammoth preserves tables in a
 * roughly markdown-ish way when we ask it to emit raw text — table cells
 * end up tab-separated within a row, rows on separate lines. That format
 * is exactly what our TSV table detector consumes downstream, so A/V
 * tables drawn in Word survive the round-trip.
 *
 * Style maps push table rows out as tab-separated text instead of the
 * default flowing text.
 */
export async function docxToText(buffer: Buffer): Promise<string> {
  const { default: mammoth } = await import('mammoth')
  // Use convertToHtml so we keep table structure, then convert tables
  // to TSV inline. mammoth.extractRawText loses table boundaries.
  const { value: html } = await mammoth.convertToHtml({ buffer })
  return htmlToTextPreservingTables(html)
}

/**
 * Take mammoth's HTML output and emit plain text with tables turned
 * into tab-separated rows (so detectAvTable() can parse them). Other
 * block elements become paragraphs separated by blank lines.
 */
function htmlToTextPreservingTables(html: string): string {
  let s = html
  // Convert <table>...</table> blocks to TSV.
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
    const rows: string[] = []
    inner.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_r: string, rowInner: string) => {
      const cells: string[] = []
      rowInner.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_c: string, cellInner: string) => {
        cells.push(stripTags(cellInner).replace(/\s+/g, ' ').trim())
        return ''
      })
      if (cells.length > 0) rows.push(cells.join('\t'))
      return ''
    })
    return '\n' + rows.join('\n') + '\n'
  })
  // Paragraph breaks
  s = s.replace(/<\/?p\b[^>]*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = stripTags(s)
  // Decode the handful of HTML entities mammoth emits.
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

/**
 * Decode a plain-text file as UTF-8.
 */
export function txtToText(buffer: Buffer): string {
  return buffer.toString('utf-8').replace(/\r\n/g, '\n')
}

/**
 * Dispatch by Slack file mimetype/filetype.
 */
export async function extractScriptFromFile(file: {
  url_private: string
  filetype?: string
  mimetype?: string
  name?: string
}): Promise<string> {
  const buf = await downloadSlackFile(file.url_private)
  const ft = (file.filetype || file.name?.split('.').pop() || '').toLowerCase()
  if (ft === 'docx' || file.mimetype?.includes('officedocument.wordprocessingml')) {
    return docxToText(buf)
  }
  if (ft === 'txt' || file.mimetype?.startsWith('text/')) {
    return txtToText(buf)
  }
  throw new Error(`Unsupported file type for storyboard script: ${ft || file.mimetype}`)
}
