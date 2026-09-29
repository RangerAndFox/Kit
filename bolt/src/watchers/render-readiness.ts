import { readSourceRange } from './upload-integrity'

export type RenderReadiness = { ready: boolean; reason?: string }
type Read = (offset: number, count: number) => Promise<Uint8Array>

/** Conservative structural gate, NOT a renderer-close signal or decoder.
 * https://developer.apple.com/documentation/quicktime-file-format/atoms
 * Require bounded, fully present mdat + moov with movie/track headers. A paused
 * render with no finalized moov must never pass just because its size is quiet.
 * Fragmented/open-ended files need an explicit completion workflow, not a guess.
 */
export async function inspectMovieContainer(size: number, read: Read): Promise<RenderReadiness> {
  let atoms = 0
  let media = false
  let movie = false
  const wait = (reason: string): RenderReadiness => ({ ready: false, reason })
  async function scan(start: number, end: number, inMovie = false): Promise<RenderReadiness> {
    let offset = start; let header = false; let track = false
    while (offset < end) {
      if (++atoms > 64) return wait('container header limit exceeded; needs explicit completion review')
      if (end - offset < 8) return wait('truncated container header')
      const bytes = await read(offset, Math.min(16, end - offset))
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let length = view.getUint32(0); let headerSize = 8
      const type = String.fromCharCode(...bytes.subarray(4, 8))
      if (length === 0) return wait('open-ended container; finalization cannot be confirmed')
      if (length === 1) {
        if (bytes.length < 16) return wait('truncated extended container header')
        const extended = view.getBigUint64(8)
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return wait('invalid extended container size')
        length = Number(extended); headerSize = 16
      }
      if (length < headerSize || length > end - offset) return wait('container data is not fully written')
      if (type === 'moof' || type === 'mvex' || type === 'cmov') {
        return wait('fragmented or compressed movie; needs explicit completion review')
      }
      if (inMovie) {
        if (type === 'mvhd') {
          if (length - headerSize < 100) return wait('movie header is not fully written')
          const data = await read(offset + headerSize, 32)
          const mvhd = new DataView(data.buffer, data.byteOffset, data.byteLength)
          const version = data[0]
          if (version > 1 || (version === 1 && length - headerSize < 112)) return wait('unsupported or incomplete movie header')
          const scale = mvhd.getUint32(version === 1 ? 20 : 12)
          const duration = version === 1 ? mvhd.getBigUint64(24) : BigInt(mvhd.getUint32(16))
          if (!scale || duration === 0n || duration === (version === 1 ? 0xffffffffffffffffn : 0xffffffffn)) {
            return wait('movie duration is not finalized')
          }
          header = true
        }
        if (type === 'trak' && length > headerSize) track = true
      } else {
        if (type === 'mdat' && length > headerSize) media = true
        if (type === 'moov') {
          const result = await scan(offset + headerSize, offset + length, true)
          if (!result.ready) return result
          movie = true
        }
      }
      offset += length
    }
    return inMovie && (!header || !track) ? wait('movie/track headers are not finalized') : { ready: true }
  }
  if (!Number.isSafeInteger(size) || size < 8) return wait('empty or truncated movie')
  const result = await scan(0, size)
  return !result.ready ? result : movie && media ? { ready: true } : wait('waiting for finalized movie and media data')
}

export async function renderReadiness(url: string, name: string, size: number): Promise<RenderReadiness> {
  if (!/\.(mp4|mov|m4v)$/i.test(name)) return { ready: true }
  const signal = AbortSignal.timeout(20_000)
  let windowStart = -1; let window: Uint8Array = new Uint8Array(0)
  return inspectMovieContainer(size, async (offset, count) => {
    if (offset < windowStart || offset + count > windowStart + window.length) {
      window = await readSourceRange(url, name, size, offset, Math.min(1024, size - offset), signal)
      windowStart = offset
    }
    return window.subarray(offset - windowStart, offset - windowStart + count)
  })
}

/** Poll new transfers promptly; cap provider traffic during long transcodes. */
export function processingPollSeconds(createdAt: string | null | undefined, now = Date.now()): number {
  const age = now - Date.parse(createdAt || '')
  if (!Number.isFinite(age) || age < 0) return 300
  return age < 10 * 60_000 ? 60 : age < 60 * 60_000 ? 120 : 300
}
