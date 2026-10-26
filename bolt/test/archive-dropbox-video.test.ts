import { beforeEach, describe, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../src/lib/dropbox/client', () => ({ dropboxRpc: io.rpc }))
import { validateDropboxVideo } from '../../src/lib/archive/dropbox'

const file = { '.tag': 'file', id: 'id:video', name: 'Final Video.MP4',
  path_display: '/production/2026/project/Final Video.MP4', size: 4096, server_modified: '2026-10-19T12:00:00Z' }
beforeEach(() => { io.rpc.mockReset() })
describe('archive Dropbox video input', () => {
  it.each([
    'https://www.dropbox.com/scl/fi/abc/Final%20Video.MP4?rlkey=key&dl=0',
    'https://www.dropbox.com/s/abc/Final%20Video.MP4?dl=1',
    '<https://www.dropbox.com/s/abc/Final%20Video.MP4?dl=0|Approved video>',
  ])('resolves a shared link from actual file metadata: %s', async link => {
    io.rpc.mockResolvedValueOnce({ '.tag': 'file', id: file.id, name: file.name }).mockResolvedValueOnce(file)
    const result = await validateDropboxVideo(link)
    expect(io.rpc.mock.calls[0][0]).toBe('/sharing/get_shared_link_metadata')
    expect(io.rpc.mock.calls[1]).toEqual(['/files/get_metadata', { path: 'id:video', include_media_info: true }, 20000])
    expect(result.path).toBe(file.path_display)
  })
  it('accepts file IDs and checks the returned filename rather than the ID extension', async () => {
    io.rpc.mockResolvedValue(file)
    expect((await validateDropboxVideo('id:video')).name).toBe('Final Video.MP4')
  })
  it('preserves direct paths and uppercase video extensions', async () => {
    io.rpc.mockResolvedValue({ ...file, name: 'Final.MOV' })
    expect((await validateDropboxVideo('/production/project/Final.MOV')).name).toBe('Final.MOV')
    expect(io.rpc.mock.calls[0][0]).toBe('/files/get_metadata')
  })
  it.each(['https://evil.test/final.mp4', 'https://dropbox.com.evil.test/final.mp4',
    'http://www.dropbox.com/s/id/final.mp4', 'https://user:password@www.dropbox.com/s/id/final.mp4'])('rejects untrusted URLs before any provider request', async link => {
    await expect(validateDropboxVideo(link)).rejects.toThrow(/HTTPS Dropbox/)
    expect(io.rpc).not.toHaveBeenCalled()
  })
  it('rejects folder links and disguised non-video filenames', async () => {
    io.rpc.mockResolvedValueOnce({ '.tag': 'folder', name: 'Delivery.mp4' })
    await expect(validateDropboxVideo('https://www.dropbox.com/scl/fo/abc?dl=0')).rejects.toThrow(/folder/)
    io.rpc.mockResolvedValueOnce({ '.tag': 'file', name: 'actual.pdf', id: 'id:pdf' })
    await expect(validateDropboxVideo('https://www.dropbox.com/s/abc/fake.mp4?dl=0')).rejects.toThrow(/not an MP4/)
  })
  it('requires the linked file to be accessible through the connected Dropbox', async () => {
    io.rpc.mockResolvedValueOnce({ '.tag': 'file', name: 'final.mp4' })
    await expect(validateDropboxVideo('https://www.dropbox.com/s/abc/final.mp4?dl=0')).rejects.toThrow(/cannot access/)
    expect(io.rpc).toHaveBeenCalledOnce()
  })
  it('returns an actionable access error without reflecting private provider payloads', async () => {
    io.rpc.mockRejectedValue(new Error('private provider payload'))
    await expect(validateDropboxVideo('https://www.dropbox.com/s/abc/final.mp4?dl=0')).rejects.toThrow(/Check its access/)
  })
  it('rejects zero-length exports', async () => {
    io.rpc.mockResolvedValue({ ...file, size: 0 })
    await expect(validateDropboxVideo('/final.mp4')).rejects.toThrow(/export and Dropbox sync/)
  })
})
