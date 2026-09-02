import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStudioProject, studioVoiceoverParagraphs } from './elevenlabs-utils.js'

test('blank Studio jobs intentionally contain no narration', () => {
  assert.deepEqual(studioVoiceoverParagraphs({ voiceover_paragraphs: [] }), [])
})

test('Studio narration is trimmed and empty entries are discarded', () => {
  assert.deepEqual(
    studioVoiceoverParagraphs({ voiceover_paragraphs: [' First line ', '', '  ', 'Second line'] }),
    ['First line', 'Second line'],
  )
})

test('Studio project URLs are parsed only from ElevenLabs', () => {
  assert.deepEqual(
    parseStudioProject('https://elevenlabs.io/app/studio/project-123'),
    { projectId: 'project-123', url: 'https://elevenlabs.io/app/studio/project-123' },
  )
  assert.throws(() => parseStudioProject('https://example.com/app/studio/project-123'), /unsafe/)
})
