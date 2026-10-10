import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import type { FeedbackComment } from './model'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'
export const MAX_DOCX_BYTES = 20 * 1024 * 1024

/** Word comments are in the saved .docx, not Drive's separate file comments. */
export async function readDocxComments(bytes: Buffer): Promise<FeedbackComment[]> {
  if (bytes.length > MAX_DOCX_BYTES) throw new Error('document_too_large')
  const zip = await JSZip.loadAsync(bytes)
  let expanded = 0
  for (const entry of Object.values(zip.files)) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0
    expanded += size
    if (expanded > 50 * 1024 * 1024) throw new Error('document_too_large')
  }
  async function xml(path: string) {
    const entry = zip.file(path)
    if (!entry) return null
    const size = (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize
    if (size > 2 * 1024 * 1024) throw new Error('document_too_large')
    // Bound actual decompressed bytes too; don't trust the ZIP directory's
    // claimed size. JSZip's Node-compatible stream uses backpressure.
    const raw = await new Promise<string>((resolve,reject) => {
      const chunks: Buffer[] = []; let length = 0, stopped = false
      const stream = entry.nodeStream('nodebuffer')
      stream.on('data', (chunk: Buffer) => {
        if (stopped) return
        length += chunk.byteLength
        if (length > 2 * 1024 * 1024) {
          stopped = true; stream.pause(); reject(new Error('document_too_large')); return
        }
        chunks.push(chunk)
      }).on('error',reject).on('end',()=>{ if (!stopped) resolve(Buffer.concat(chunks).toString('utf8')) })
    })
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('unsafe_document_xml')
    const invalid = () => { throw new Error('invalid_document_xml') }
    return new DOMParser({ errorHandler: { warning: invalid, error: invalid, fatalError: invalid } }).parseFromString(raw, 'text/xml')
  }
  const doc = await xml('word/comments.xml')
  if (!doc) return []
  if (doc.documentElement?.namespaceURI !== W || doc.documentElement?.localName !== 'comments') throw new Error('invalid_document_xml')
  const ex = await xml('word/commentsExtended.xml')
  const extensions = new Map(Array.from(ex?.getElementsByTagNameNS(W15, 'commentEx') || []).map(e => [e.getAttributeNS(W15, 'paraId'), e]))
  const elements = Array.from(doc.getElementsByTagNameNS(W, 'comment'))
  if (elements.length > 500) throw new Error('too_many_comments')
  const paragraphId = (e: Element) => Array.from(e.getElementsByTagNameNS(W, 'p')).at(-1)?.getAttributeNS(W14, 'paraId') || ''
  const ids = new Map(elements.map(e => [paragraphId(e as unknown as Element), e.getAttributeNS(W, 'id')]))
  return elements.map(e => {
    const ext = extensions.get(paragraphId(e as unknown as Element))
    const parentParagraph = ext?.getAttributeNS(W15, 'paraIdParent')
    const parentId = parentParagraph ? ids.get(parentParagraph) : undefined
    return {
      id: `word:${e.getAttributeNS(W, 'id')}`, parentId: parentId ? `word:${parentId}` : undefined,
      author: e.getAttributeNS(W, 'author') || 'Unknown author', date: e.getAttributeNS(W, 'date') || '',
      text: Array.from(e.getElementsByTagNameNS(W, 'p')).map(p => Array.from(p.getElementsByTagNameNS(W, 't')).map(t => t.textContent || '').join('')).join('\n'),
      resolved: ext ? ext.getAttributeNS(W15, 'done') === '1' : null,
    }
  })
}
