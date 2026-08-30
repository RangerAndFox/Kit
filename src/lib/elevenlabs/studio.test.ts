import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createStudioProject,
  requiresStudioBrowserFallback,
  studioProjectUrl,
  voiceoverParagraphs,
} from './studio'

const originalFetch = globalThis.fetch
const originalKey = process.env.ELEVENLABS_API_KEY

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = 'test-key-do-not-log'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
  else process.env.ELEVENLABS_API_KEY = originalKey
})

describe('ElevenLabs Studio', () => {
  it('extracts only non-empty VO paragraphs from storyboard frames', () => {
    assert.deepEqual(
      voiceoverParagraphs([
        { label: '1', sound: ' First line. ', action: 'Never include this visual.' },
        { label: '2', sound: '', action: 'Another visual.' },
        { label: '3', sound: 'Second line.', action: '' },
      ]),
      ['First line.', 'Second line.'],
    )
  })

  it('creates a Studio project from a narration-only text document', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (!init?.method) {
        return new Response(JSON.stringify({ projects: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ project: { project_id: 'studio-123', name: '2697 Test' } }), {
        status: 200,
      })
    }) as typeof fetch

    const project = await createStudioProject({
      name: '2697 Test',
      frames: [
        { label: '1', sound: 'Narration one.', action: 'Visual one.' },
        { label: '2', sound: 'Narration two.', action: 'Visual two.' },
      ],
    })

    assert.equal(project.id, 'studio-123')
    assert.equal(project.url, studioProjectUrl('studio-123'))
    assert.equal(calls.length, 2)
    const form = calls[1].init?.body as FormData
    assert.equal(form.get('name'), '2697 Test')
    const document = form.get('from_document') as File
    assert.equal(await document.text(), 'Narration one.\n\nNarration two.')
    assert.doesNotMatch(await document.text(), /Visual/)
  })

  it('reuses an exact-name project during a retry', async () => {
    let postCount = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') postCount += 1
      return new Response(JSON.stringify({
        projects: [{ project_id: 'existing-1', name: 'Existing Project' }],
      }), { status: 200 })
    }) as typeof fetch

    const project = await createStudioProject({
      name: 'Existing Project',
      frames: [{ label: '1', sound: 'VO', action: '' }],
    })
    assert.equal(project.id, 'existing-1')
    assert.equal(postCount, 0)
  })

  it('identifies the account-level Studio API restriction for browser fallback', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      detail: {
        status: 'invalid_subscription',
        message: 'Studio API access requires account approval.',
      },
    }), { status: 403 })) as typeof fetch

    await assert.rejects(
      createStudioProject({
        name: 'Fallback Test',
        frames: [{ label: '1', sound: 'VO', action: '' }],
      }),
      (error: unknown) => requiresStudioBrowserFallback(error),
    )
  })
})
