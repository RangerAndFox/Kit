import type { ElevenLabsStudioJob } from './types.js'

export function parseStudioProject(urlValue: string): { projectId: string; url: string } {
  const url = new URL(urlValue)
  if (!/(^|\.)elevenlabs\.io$/i.test(url.hostname)) throw new Error('ElevenLabs returned an unsafe project URL.')
  const match = url.pathname.match(/^\/app\/studio\/([^/?#]+)/i)
  if (!match) throw new Error('ElevenLabs opened Studio but returned no project id.')
  return { projectId: decodeURIComponent(match[1]), url: url.toString() }
}

export function studioVoiceoverParagraphs(job: Pick<ElevenLabsStudioJob, 'voiceover_paragraphs'>): string[] {
  return Array.isArray(job.voiceover_paragraphs)
    ? job.voiceover_paragraphs.map(String).map((value) => value.trim()).filter(Boolean)
    : []
}
