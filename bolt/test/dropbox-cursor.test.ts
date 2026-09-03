import { describe, expect, it } from 'vitest'
import { classifyDropboxEntry } from '../src/watchers/dropbox.js'

describe('durable Dropbox event classification', () => {
  it('uses file id and revision for a stable replay key', () => {
    const entry = {
      tag: 'file',
      path_lower: '/production/2026/2637_fabric/09_outgoing/01_client progress/cut.mov',
      path_display: '/production/2026/2637_Fabric/09_Outgoing/01_Client Progress/cut.mov',
      name: 'cut.mov',
      id: 'id:abc',
      rev: '015',
      size: 42,
    }
    const first = classifyDropboxEntry(entry)
    const replay = classifyDropboxEntry({ ...entry, path_display: entry.path_display })
    const nextRevision = classifyDropboxEntry({ ...entry, rev: '016' })

    expect(first?.event_type).toBe('frameio_delivery')
    expect(replay?.event_key).toBe(first?.event_key)
    expect(nextRevision?.event_key).not.toBe(first?.event_key)
  })

  it('routes every supported path and ignores folders or denied sidecars', () => {
    const base = { tag: 'file', path_lower: '', name: '', id: 'id:x', rev: '1' }
    expect(classifyDropboxEntry({
      ...base,
      path_display: '/production/2026/2637_Fabric/02_Accessibility Files/cut.srt',
    })?.event_type).toBe('accessibility_srt')
    expect(classifyDropboxEntry({
      ...base,
      path_display: '/production/2026/2637_Fabric/08_AE/03_RenderFarm/cut.aep',
    })?.event_type).toBe('ae_render')
    expect(classifyDropboxEntry({
      ...base,
      path_display: '/production/2026/2637_Fabric/09_Outgoing/02_Delivery/audio.aac',
    })).toBeNull()
    expect(classifyDropboxEntry({
      ...base,
      tag: 'folder',
      path_display: '/production/2026/2637_Fabric/09_Outgoing/02_Delivery',
    })).toBeNull()
    expect(classifyDropboxEntry({
      ...base,
      path_display: "/production/2026/2637_Fabric/09_Outgoing/01_Client Progress/cut (Ranger & Fox's conflicted copy 2026-09-01).mp4",
    })).toBeNull()
  })
})
