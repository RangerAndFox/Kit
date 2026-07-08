import { describe, it, expect } from 'vitest'

import {
  parseSrt,
  cuesToVtt,
  cuesToTtml,
  cuesToTxt,
  convertSrt,
  isSrtFile,
  siblingPaths,
} from '../../src/lib/delivery/subtitle-convert'

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,000
Two lines here
& a second one.

3
00:00:07,250 --> 00:00:09,000
<i>Styled</i> text
`

describe('parseSrt', () => {
  it('parses cues with indices, timing, multi-line text', () => {
    const cues = parseSrt(SRT)
    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({ start: '00:00:01,000', end: '00:00:03,500', lines: ['Hello there.'] })
    expect(cues[1].lines).toEqual(['Two lines here', '& a second one.'])
  })

  it('handles CRLF and BOM', () => {
    const crlf = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n'
    expect(parseSrt(crlf)).toHaveLength(1)
  })

  it('skips malformed blocks and works without index lines', () => {
    const messy = `garbage block

00:00:01,000 --> 00:00:02,000
No index line here

99
not a timing line
`
    const cues = parseSrt(messy)
    expect(cues).toHaveLength(1)
    expect(cues[0].lines).toEqual(['No index line here'])
  })
})

describe('cuesToVtt', () => {
  it('emits WEBVTT header and dot times, keeps styling tags', () => {
    const vtt = cuesToVtt(parseSrt(SRT))
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500')
    expect(vtt).toContain('<i>Styled</i> text')
    expect(vtt).not.toContain(',000 -->')
  })
})

describe('cuesToTtml', () => {
  it('emits valid-shaped TTML with escaped text and <br/> line joins', () => {
    const ttml = cuesToTtml(parseSrt(SRT))
    expect(ttml).toContain('<tt xmlns="http://www.w3.org/ns/ttml"')
    expect(ttml).toContain('<p begin="00:00:04.000" end="00:00:06.000">Two lines here<br/>&amp; a second one.</p>')
    // styling tags stripped, not escaped into visible text
    expect(ttml).toContain('>Styled text</p>')
    expect(ttml).not.toContain('&lt;i&gt;')
  })
})

describe('cuesToTxt', () => {
  it('plain transcript, no timestamps, tags stripped', () => {
    const txt = cuesToTxt(parseSrt(SRT))
    expect(txt).toBe('Hello there.\nTwo lines here\n& a second one.\nStyled text\n')
  })
})

describe('convertSrt', () => {
  it('returns all three formats plus cue count', () => {
    const r = convertSrt(SRT)
    expect(r.cueCount).toBe(3)
    expect(r.vtt).toContain('WEBVTT')
    expect(r.ttml).toContain('</tt>')
    expect(r.txt).toContain('Hello there.')
  })

  it('throws on unparseable input', () => {
    expect(() => convertSrt('not a subtitle file')).toThrow(/no parseable cues/)
  })
})

describe('file naming', () => {
  it('detects .srt case-insensitively', () => {
    expect(isSrtFile('Spot_V2.SRT')).toBe(true)
    expect(isSrtFile('Spot_V2.mov')).toBe(false)
  })

  it('derives sibling paths with the same basename', () => {
    expect(siblingPaths('/Delivery-Queue/Acme/Spot_V2.srt')).toEqual({
      ttml: '/Delivery-Queue/Acme/Spot_V2.ttml',
      vtt: '/Delivery-Queue/Acme/Spot_V2.vtt',
      txt: '/Delivery-Queue/Acme/Spot_V2.txt',
    })
  })
})
