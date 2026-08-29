import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { behanceContentModules } from './layout.js'
import type { BehanceManifest } from './types.js'

const manifest = (patch: Partial<BehanceManifest> = {}): BehanceManifest => ({
  title: 'Microsoft Copilot Studio | Icon Animation',
  subtitle: 'Icon Announcement Video',
  descriptions: ['Hero introduction', 'Creative approach', 'Craft detail'],
  credits: 'Creative Director: Jonathan Larson',
  services: ['Animation'], tags: ['Microsoft'],
  media: ['/Main/hero.jpg', '/Main/detail.gif', '/Process/boards.jpg'],
  ...patch,
})

describe('Behance content layout', () => {
  it('places approved website copy around media like the Ranger & Fox reference', () => {
    assert.deepEqual(behanceContentModules(manifest()), [
      { kind: 'text', role: 'title', text: 'Microsoft Copilot Studio | Icon Animation\nIcon Announcement Video' },
      { kind: 'media', paths: ['/Main/hero.jpg'] },
      { kind: 'text', role: 'description', text: 'Hero introduction' },
      { kind: 'media', paths: ['/Main/detail.gif'] },
      { kind: 'text', role: 'description', text: 'Creative approach' },
      { kind: 'text', role: 'heading', text: 'Process' },
      { kind: 'media', paths: ['/Process/boards.jpg'] },
      { kind: 'text', role: 'description', text: 'Craft detail' },
      { kind: 'text', role: 'credits', text: 'Creative Director: Jonathan Larson' },
    ])
  })

  it('rejects module media that is not in the approved archive manifest', () => {
    const modules = behanceContentModules(manifest({
      contentModules: [
        { kind: 'media', paths: ['/Main/hero.jpg', '/private/not-approved.jpg'] },
        { kind: 'text', role: 'credits', text: '  Verified Artist  ' },
      ],
    }))
    assert.deepEqual(modules, [
      { kind: 'media', paths: ['/Main/hero.jpg'] },
      { kind: 'text', role: 'credits', text: 'Verified Artist' },
    ])
  })
})
