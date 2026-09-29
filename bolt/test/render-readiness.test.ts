import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectMovieContainer, processingPollSeconds, renderReadiness } from '../src/watchers/render-readiness'
import { readSourceRange } from '../src/watchers/upload-integrity'

function atom(type: string, data = Buffer.alloc(4), extended = false): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8)
  header.writeUInt32BE(extended ? 1 : header.length + data.length); header.write(type, 4)
  if (extended) header.writeBigUInt64BE(BigInt(header.length + data.length), 8)
  return Buffer.concat([header, data])
}
const movieHeader = Buffer.alloc(100)
movieHeader.writeUInt32BE(1000, 12); movieHeader.writeUInt32BE(1000, 16)
const moov = atom('moov', Buffer.concat([atom('mvhd', movieHeader), atom('trak')]))
const mdat = atom('mdat', Buffer.alloc(2048))
const inspect = (bytes: Buffer) => inspectMovieContainer(bytes.length, async (offset, count) => bytes.subarray(offset, offset + count))
afterEach(() => vi.unstubAllGlobals())

describe('direct render structural readiness', () => {
  it.each(['head', 'tail'])('accepts bounded finalized movie metadata at the %s', async position => {
    expect(await inspect(Buffer.concat(position === 'head' ? [moov, mdat] : [mdat, moov]))).toEqual({ ready: true })
  })
  it('handles extended-size mdat without reading the media', async () => {
    const bytes = Buffer.concat([atom('mdat', Buffer.alloc(5000), true), moov]); let read = 0
    expect(await inspectMovieContainer(bytes.length, async (offset, count) => {
      read += count; return bytes.subarray(offset, offset + count)
    })).toEqual({ ready: true })
    expect(read).toBeLessThan(120)
  })
  it.each(['missing moov', 'missing media', 'truncated media', 'truncated moov', 'empty moov', 'no track', 'open-ended', 'fragmented', 'compressed', 'bad length', 'partial header', 'huge length'])('holds %s without certifying a finished render', async kind => {
    let bytes: Buffer = Buffer.concat([mdat, moov])
    if (kind === 'missing moov') bytes = mdat
    if (kind === 'missing media') bytes = moov
    if (kind === 'truncated media') bytes = mdat.subarray(0, 100)
    if (kind === 'truncated moov') bytes = bytes.subarray(0, bytes.length - 1)
    if (kind === 'empty moov') bytes = Buffer.concat([mdat, atom('moov', Buffer.alloc(0))])
    if (kind === 'no track') bytes = Buffer.concat([mdat, atom('moov', atom('mvhd'))])
    if (kind === 'open-ended') { bytes = Buffer.from(bytes); bytes.writeUInt32BE(0) }
    if (kind === 'fragmented') bytes = Buffer.concat([moov, atom('moof'), mdat])
    if (kind === 'compressed') bytes = Buffer.concat([mdat, atom('moov', atom('cmov'))])
    if (kind === 'bad length') { bytes = Buffer.from(bytes); bytes.writeUInt32BE(4) }
    if (kind === 'partial header') bytes = Buffer.from([0, 0, 0, 8])
    if (kind === 'huge length') { bytes = atom('mdat', Buffer.alloc(8), true); bytes.writeBigUInt64BE(2n ** 63n, 8) }
    expect((await inspect(bytes)).ready).toBe(false)
  })
  it('bounds pathological container work', async () => {
    expect(await inspect(Buffer.concat([...Array(65)].map(() => atom('free'))))).toMatchObject({ ready: false, reason: expect.stringMatching(/limit/) })
  })
  it.each([0, 0xffffffff])('holds a placeholder movie duration %s', async duration => {
    const header = Buffer.from(movieHeader); header.writeUInt32BE(duration, 16)
    expect(await inspect(Buffer.concat([mdat, atom('moov', Buffer.concat([atom('mvhd', header), atom('trak')]))])))
      .toMatchObject({ ready: false, reason: expect.stringMatching(/duration/) })
  })
  it('supports version-one 64-bit durations', async () => {
    const header = Buffer.alloc(112); header[0] = 1
    header.writeUInt32BE(1000, 20); header.writeBigUInt64BE(1000n, 24)
    expect(await inspect(Buffer.concat([mdat, atom('moov', Buffer.concat([atom('mvhd', header), atom('trak')]))])))
      .toEqual({ ready: true })
  })
  it('does not reinterpret images or other video formats as MP4', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(await renderReadiness('unused', 'frame.png', 42)).toEqual({ ready: true })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reads bounded exact ranges from one revision, skipping large media payloads', async () => {
    const bytes = Buffer.concat([mdat, moov]); const offsets: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const [start, end] = options.headers.Range.slice(6).split('-').map(Number)
      offsets.push(start)
      return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
        'content-type': 'video/quicktime', 'content-range': `bytes ${start}-${end}/${bytes.length}`,
      } })
    }))
    expect(await renderReadiness('https://uc1.dl.dropboxusercontent.com/file', 'movie.mov', bytes.length)).toEqual({ ready: true })
    expect(offsets).toEqual([0, mdat.length])
  })
  it('rejects ignored or forged nonzero ranges, and cancels the stream', async () => {
    for (const status of [200, 206]) {
      const cancel = vi.fn()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
        status, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-7/100' },
      })))
      await expect(readSourceRange('https://uc1.dl.dropboxusercontent.com/file', 'movie.mp4', 100, 50, 8)).rejects.toThrow(/range/)
      expect(cancel).toHaveBeenCalledOnce()
    }
  })
  it('uses fast initial processing polls and bounded backoff for older transfers', () => {
    const now = Date.now(); const stamp = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
    expect(processingPollSeconds(stamp(0), now)).toBe(60)
    expect(processingPollSeconds(stamp(9), now)).toBe(60)
    expect(processingPollSeconds(stamp(10), now)).toBe(120)
    expect(processingPollSeconds(stamp(60), now)).toBe(300)
    expect(processingPollSeconds(undefined, now)).toBe(300)
  })
})
