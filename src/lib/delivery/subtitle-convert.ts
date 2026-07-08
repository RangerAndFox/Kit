/**
 * SRT → TTML / VTT / TXT conversion (pure — no I/O, unit-tested).
 *
 * When an .srt lands in /Delivery-Queue/, the delivery scan generates the
 * three sibling caption formats next to it (same basename). Parsing is
 * tolerant: BOM/CRLF handled, malformed blocks skipped, out-of-order
 * indices preserved as-is.
 */

export interface SrtCue {
  start: string // HH:MM:SS,mmm (SRT comma form)
  end: string
  lines: string[]
}

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

function normalizeTime(raw: string): string | null {
  const m = raw.match(TIME_RE)
  if (!m) return null
  const [, h, mm, ss, ms] = m
  return `${h.padStart(2, '0')}:${mm}:${ss},${ms.padEnd(3, '0')}`
}

export function parseSrt(text: string): SrtCue[] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = clean.split(/\n{2,}/)
  const cues: SrtCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) continue
    // Optional numeric index line, then the timing line.
    let i = 0
    if (/^\d+$/.test(lines[0])) i = 1
    const timing = lines[i]
    if (!timing || !timing.includes('-->')) continue
    const [rawStart, rawEnd] = timing.split('-->')
    const start = normalizeTime(rawStart || '')
    const end = normalizeTime(rawEnd || '')
    if (!start || !end) continue
    const textLines = lines.slice(i + 1)
    if (textLines.length === 0) continue
    cues.push({ start, end, lines: textLines })
  }
  return cues
}

/** SRT comma-time → dot-time (VTT/TTML form). */
function dotTime(srtTime: string): string {
  return srtTime.replace(',', '.')
}

/** Strip SRT styling tags (<i>, <b>, <u>, <font …>) for formats that shouldn't carry them. */
function stripTags(s: string): string {
  return s.replace(/<\/?[a-z][^>]*>/gi, '')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function cuesToVtt(cues: SrtCue[]): string {
  const body = cues
    .map((c) => `${dotTime(c.start)} --> ${dotTime(c.end)}\n${c.lines.join('\n')}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

export function cuesToTtml(cues: SrtCue[], lang = 'en'): string {
  const paragraphs = cues
    .map((c) => {
      const text = c.lines.map((l) => escapeXml(stripTags(l))).join('<br/>')
      return `      <p begin="${dotTime(c.start)}" end="${dotTime(c.end)}">${text}</p>`
    })
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="${lang}">`,
    '  <body>',
    '    <div>',
    paragraphs,
    '    </div>',
    '  </body>',
    '</tt>',
    '',
  ].join('\n')
}

export function cuesToTxt(cues: SrtCue[]): string {
  return cues.map((c) => stripTags(c.lines.join('\n'))).join('\n') + '\n'
}

export interface ConvertedSubtitles {
  vtt: string
  ttml: string
  txt: string
  cueCount: number
}

/** Convert raw SRT text into all three sibling formats. Throws if no cues parse. */
export function convertSrt(srtText: string): ConvertedSubtitles {
  const cues = parseSrt(srtText)
  if (cues.length === 0) throw new Error('no parseable cues in SRT')
  return {
    vtt: cuesToVtt(cues),
    ttml: cuesToTtml(cues),
    txt: cuesToTxt(cues),
    cueCount: cues.length,
  }
}

export function isSrtFile(name: string): boolean {
  return /\.srt$/i.test(name)
}

/** "/path/Spot_V2.srt" → { ttml: "/path/Spot_V2.ttml", vtt: ..., txt: ... } */
export function siblingPaths(srtPath: string): { ttml: string; vtt: string; txt: string } {
  const base = srtPath.replace(/\.srt$/i, '')
  return { ttml: `${base}.ttml`, vtt: `${base}.vtt`, txt: `${base}.txt` }
}
