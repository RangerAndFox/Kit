import { describe, it, expect } from 'vitest'
import {
  buildFrameioShareRequest,
  classifyFrameioUploadStatus,
  isDeniedDeliveryFile,
  normalizeFrameioStatusPath,
  resolveFrameioIdForProject,
  selectFrameioProjectByNumber,
} from '../src/watchers/dropbox'

describe('Frame.io remote-upload readiness', () => {
  it('does not treat accepted or processing states as ready', () => {
    for (const status of ['', 'created', 'uploading', 'processing', 'transcoding']) {
      expect(classifyFrameioUploadStatus(status)).toBe('processing')
    }
  })

  it('recognizes terminal success and failure states', () => {
    expect(classifyFrameioUploadStatus('completed')).toBe('ready')
    expect(classifyFrameioUploadStatus('ready')).toBe('ready')
    expect(classifyFrameioUploadStatus('failed')).toBe('failed')
    expect(classifyFrameioUploadStatus('cancelled')).toBe('failed')
  })

  it('normalizes the documented absolute status URL without changing API paths', () => {
    expect(normalizeFrameioStatusPath('https://api.frame.io/v4/accounts/a/files/f/status'))
      .toBe('/accounts/a/files/f/status')
    expect(normalizeFrameioStatusPath('/accounts/a/files/f/status'))
      .toBe('/accounts/a/files/f/status')
  })
})

describe('buildFrameioShareRequest', () => {
  it('uses the Frame.io v4 project share contract with the uploaded asset', () => {
    expect(
      buildFrameioShareRequest(
        'account-123',
        'project-456',
        'file-789',
        '02_Delivery – final.mov',
      ),
    ).toEqual({
      path: '/accounts/account-123/projects/project-456/shares',
      body: {
        data: {
          type: 'asset',
          name: '02_Delivery – final.mov',
          access: 'public',
          asset_ids: ['file-789'],
        },
      },
    })
  })
})

describe('isDeniedDeliveryFile', () => {
  it('denies the default .aac and .m4v extensions', () => {
    expect(isDeniedDeliveryFile('mix.aac')).toBe(true)
    expect(isDeniedDeliveryFile('hero-cut.m4v')).toBe(true)
  })

  it('allows real video deliverables', () => {
    expect(isDeniedDeliveryFile('hero-cut-v3.mov')).toBe(false)
    expect(isDeniedDeliveryFile('promo.mp4')).toBe(false)
    expect(isDeniedDeliveryFile('master.mxf')).toBe(false)
  })

  it('is case-insensitive and only looks at the final path segment', () => {
    expect(isDeniedDeliveryFile('051326/v1/MIX.AAC')).toBe(true)
    expect(isDeniedDeliveryFile('051326/v1/asset.mov')).toBe(false)
    // A subfolder named like an extension must not trip the check.
    expect(isDeniedDeliveryFile('mix.aac/asset.mov')).toBe(false)
  })

  it('handles dotless names and dotfiles safely', () => {
    expect(isDeniedDeliveryFile('READme')).toBe(false)
    expect(isDeniedDeliveryFile('.aac')).toBe(false) // leading-dot only, no basename
  })

  it('honors a custom deny set', () => {
    const deny = new Set(['wav', 'mp3'])
    expect(isDeniedDeliveryFile('stem.wav', deny)).toBe(true)
    expect(isDeniedDeliveryFile('mix.aac', deny)).toBe(false)
  })
})

describe('resolveFrameioIdForProject', () => {
  it('reuses an existing Frame.io id without discovery or writes', async () => {
    let calls = 0
    const id = await resolveFrameioIdForProject(
      { external_links: { frameio_id: 'frame-existing' } },
      '2637_Microsoft_Fabric_IQ_Sizzle',
      {
        findByProjectNumber: async () => { calls++; return null },
        persistLink: async () => { calls++ },
      },
    )

    expect(id).toBe('frame-existing')
    expect(calls).toBe(0)
  })

  it('discovers and persists a missing link for an existing synced project', async () => {
    const searched: string[] = []
    const persisted: Array<{ id: string; name: string }> = []
    const found = { id: 'frame-fabric', name: '2637_Microsoft_Fabric IQ Sizzle' }

    const id = await resolveFrameioIdForProject(
      { external_links: { slack_id: 'C123', dropbox_id: '/production/2026/2637_Microsoft_Fabric_IQ_Sizzle' } },
      '2637_Microsoft_Fabric_IQ_Sizzle',
      {
        findByProjectNumber: async (projectNumber) => { searched.push(projectNumber); return found },
        persistLink: async (match) => { persisted.push(match) },
      },
    )

    expect(id).toBe('frame-fabric')
    expect(searched).toEqual(['2637'])
    expect(persisted).toEqual([found])
  })

  it('returns null without persisting when no Frame.io project can be found', async () => {
    let persisted = false
    const id = await resolveFrameioIdForProject(
      { external_links: { slack_id: 'C123' } },
      '2637_Microsoft_Fabric_IQ_Sizzle',
      {
        findByProjectNumber: async () => null,
        persistLink: async () => { persisted = true },
      },
    )

    expect(id).toBeNull()
    expect(persisted).toBe(false)
  })
})

describe('selectFrameioProjectByNumber', () => {
  const projects = [
    { id: 'p2633', name: '2633_Microsoft_Biz Apps' },
    { id: 'p2637', name: 'Microsoft - 2637 Fabric IQ' },
  ]

  it('prefers one strict project-number match', () => {
    expect(selectFrameioProjectByNumber(projects, '2633')).toEqual({
      match: projects[0],
      reason: 'strict',
    })
  })

  it('uses one boundary-safe lenient match when no strict match exists', () => {
    expect(selectFrameioProjectByNumber(projects, '2637')).toEqual({
      match: projects[1],
      reason: 'lenient',
    })
  })

  it('fails closed when the project number is ambiguous', () => {
    const ambiguous = [...projects, { id: 'p2633b', name: '2633_Microsoft_Second' }]
    expect(selectFrameioProjectByNumber(ambiguous, '2633')).toEqual({
      match: null,
      reason: 'ambiguous',
    })
  })
})
