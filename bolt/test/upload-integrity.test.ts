import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertExactSource, assertSourceContentType, frameFileReadiness, sourceReadiness, verifySourceLink } from '../src/watchers/upload-integrity'

const now = Date.parse('2026-09-22T19:10:00Z')
const source = { id: 'id:video', rev: 'abcdef12345', size: 129354101, server_modified: '2026-09-22T19:08:00Z' }
const expected = { dropboxId: source.id, rev: source.rev, sizeBytes: source.size, firstSeenAt: '2026-09-22T19:08:00Z' }
const target = { id: 'file', folderId: 'folder', projectId: 'project', name: 'MRA.mp4', size: source.size }
const file = { id: 'file', parent_id: 'folder', project_id: 'project', file_size: source.size, media_type: 'video/mp4', status: 'transcoded' }
afterEach(() => vi.unstubAllGlobals())

describe('source stability and pinned identity', () => {
  it('accepts the same nonempty revision observed over a quiet minute', () => {
    expect(sourceReadiness(expected, source, now)).toBe('ready')
  })
  it('waits on fresh observations and fresh source modifications', () => {
    expect(sourceReadiness({ ...expected, firstSeenAt: new Date(now - 10_000).toISOString() }, source, now)).toBe('wait')
    expect(sourceReadiness(expected, { ...source, server_modified: new Date(now - 10_000).toISOString() }, now)).toBe('wait')
  })
  it('waits for zero-byte files and rejects changed sizes', () => {
    expect(sourceReadiness(expected, { ...source, size: 0 }, now)).toBe('wait')
    expect(() => sourceReadiness(expected, { ...source, size: 12 }, now)).toThrow(/size mismatch/)
  })
  it('distinguishes superseded revisions from another source identity', () => {
    expect(sourceReadiness(expected, { ...source, rev: 'newer' }, now)).toBe('superseded')
    expect(() => sourceReadiness(expected, { ...source, id: 'id:other' }, now)).toThrow(/identity mismatch/)
  })
  it('does not infer stability with missing timestamps or identity', () => {
    expect(sourceReadiness({ ...expected, firstSeenAt: undefined }, source, now)).toBe('wait')
    expect(() => sourceReadiness({ ...expected, rev: '' }, source, now)).toThrow(/identity\/revision/)
  })
  it('rejects a temporary link for a different revision, ID, or byte count', () => {
    expect(assertExactSource(expected, source)).toBe(source.size)
    for (const invalid of [{ ...source, rev: 'new' }, { ...source, id: 'other' }, { ...source, size: 0 }, { ...source, size: 1 }]) {
      expect(() => assertExactSource(expected, invalid)).toThrow(/queued revision/)
    }
  })
})

describe('download preflight', () => {
  it('rejects JSON and HTML masquerading as video', () => {
    for (const mime of ['application/json', 'text/html; charset=utf-8', 'text/plain']) {
      expect(() => assertSourceContentType('video.mp4', mime)).toThrow(/integrity/)
    }
    expect(() => assertSourceContentType('video.mp4', 'application/octet-stream')).not.toThrow()
    expect(() => assertSourceContentType('captions.vtt', 'text/plain')).not.toThrow()
  })
  it('checks the bounded GET representation even when HEAD would return JSON', async () => {
    const fetch = vi.fn().mockImplementation((_url, options) => options.method === 'HEAD'
      ? new Response(null, { headers: { 'content-type': 'application/json' } })
      : new Response(new Uint8Array(1024), { status: 206, headers: {
        'content-type': 'video/mp4', 'content-length': '1024', 'content-range': `bytes 0-1023/${source.size}`,
      } }))
    vi.stubGlobal('fetch', fetch)
    await verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', source.size)
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'GET', headers: { Range: 'bytes=0-1023', 'Accept-Encoding': 'identity' }, redirect: 'manual', signal: expect.any(AbortSignal) }))
  })
  it('rejects arbitrary hosts before any request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(verifySourceLink('https://evil.test/file', 'video.mp4', 1)).rejects.toThrow(/host/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('allows bounded Dropbox CDN redirects but never redirects to another host', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://uc456.dl.dropboxusercontent.com/file' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(123), { headers: { 'content-type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetch)
    await verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', 123)
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } }))
    await expect(verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', 123)).rejects.toThrow(/host/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects provider errors, incorrect lengths and error content', async () => {
    for (const response of [new Response(null, { status: 429 }), new Response(null, { headers: { 'content-length': '0' } }),
      new Response(null, { headers: { 'content-type': 'application/json' } })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      await expect(verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', source.size)).rejects.toThrow()
    }
  })
  it('cancels rather than downloads the whole video when Range is ignored', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)) }, cancel })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(source.size) } })))
    await verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', source.size)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['bytes 1-1024/12345', 'bytes 0-1023/*', 'bytes 0-512/12345', 'bytes 0-1023/12346'])('rejects invalid range evidence %s', async (range) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(1024), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': range } })))
    await expect(verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', 12345)).rejects.toThrow(/range\/size/)
  })
  it('rejects an empty or truncated body despite valid headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(10), { headers: { 'content-type': 'video/mp4' } })))
    await expect(verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', 123)).rejects.toThrow(/truncated/)
  })
  it('cancels error bodies without reading them', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } })))
    await expect(verifySourceLink('https://uc123.dl.dropboxusercontent.com/file', 'video.mp4', 123)).rejects.toThrow(/application\/json/)
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('Frame.io integrity and playable processing gate', () => {
  it('accepts the observed valid MRA video', () => expect(frameFileReadiness(file, target)).toBe('ready'))
  it('rejects the observed 0-byte JSON file even when marked transcoded', () => {
    expect(() => frameFileReadiness({ ...file, file_size: 0, media_type: 'application/json' }, target)).toThrow(/size/)
  })
  it('rejects a correct-size error response and wrong file destinations', () => {
    expect(() => frameFileReadiness({ ...file, media_type: 'application/json' }, target)).toThrow(/media type/)
    for (const key of ['id', 'parent_id', 'project_id']) expect(() => frameFileReadiness({ ...file, [key]: 'wrong' }, target)).toThrow(/identity/)
  })
  it.each(['created', 'uploaded', 'completed', 'processing', 'transcoding'])('does not announce video in %s state', (status) => {
    expect(frameFileReadiness({ ...file, status }, target)).toBe('processing')
  })
  it('rejects failed transcodes and absent source proof', () => {
    expect(() => frameFileReadiness({ ...file, status: 'transcode_failed' }, target)).toThrow(/processing failed/)
    expect(() => frameFileReadiness(file, { ...target, size: NaN })).toThrow(/size/)
  })
  it('validates audio and images without requiring video content types', () => {
    expect(frameFileReadiness({ ...file, media_type: 'audio/mpeg' }, { ...target, name: 'mix.mp3' })).toBe('ready')
    expect(frameFileReadiness({ ...file, media_type: 'image/png' }, { ...target, name: 'frame.png' })).toBe('ready')
  })
  it('does not wait for nonexistent video transcoding on a completed sidecar upload', () => {
    expect(frameFileReadiness({ ...file, media_type: 'text/plain', status: 'created' }, { ...target, name: 'captions.vtt' })).toBe('ready')
  })
})
