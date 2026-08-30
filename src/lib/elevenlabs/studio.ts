import type { BoordsFrame } from '../boords/client'

const BASE_URL = 'https://api.elevenlabs.io/v1'
const DEFAULT_TIMEOUT_MS = 45_000

export interface ElevenLabsStudioProject {
  id: string
  name: string
  url: string
}

function apiKey(): string {
  const value = process.env.ELEVENLABS_API_KEY?.trim()
  if (!value) throw new Error('ELEVENLABS_API_KEY is not configured')
  return value
}

export function studioProjectUrl(projectId: string): string {
  const template = process.env.ELEVENLABS_STUDIO_URL_TEMPLATE?.trim()
  if (template) return template.replace('{projectId}', encodeURIComponent(projectId))
  return `https://elevenlabs.io/app/studio/${encodeURIComponent(projectId)}`
}

export function voiceoverParagraphs(frames: BoordsFrame[]): string[] {
  return frames
    .map((frame) => String(frame.sound || '').trim())
    .filter((text) => text.length > 0 && !/^[-—–]+$/.test(text))
}

async function request(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'xi-api-key': apiKey(),
        ...(init.headers || {}),
      },
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    })
  } catch (error: any) {
    const message = error?.name === 'TimeoutError'
      ? `ElevenLabs ${path} timed out after ${Math.round(timeoutMs / 1000)}s`
      : `ElevenLabs ${path} request failed: ${error?.message || String(error)}`
    throw new Error(message, { cause: error })
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`ElevenLabs ${path}: ${response.status}${detail ? ` ${detail}` : ''}`)
  }
  return response.json() as Promise<any>
}

export async function listStudioProjects(): Promise<ElevenLabsStudioProject[]> {
  const body = await request('/studio/projects')
  const projects = Array.isArray(body?.projects) ? body.projects : []
  return projects
    .filter((project: any) => project?.project_id && project?.name)
    .map((project: any) => ({
      id: String(project.project_id),
      name: String(project.name),
      url: studioProjectUrl(String(project.project_id)),
    }))
}

export async function createStudioProject(input: {
  name: string
  frames: BoordsFrame[]
  reconcileExisting?: boolean
}): Promise<ElevenLabsStudioProject> {
  const name = input.name.trim()
  const paragraphs = voiceoverParagraphs(input.frames)
  if (!name) throw new Error('ElevenLabs Studio project name is required')
  if (paragraphs.length === 0) throw new Error('No voiceover was detected for ElevenLabs Studio')

  if (input.reconcileExisting !== false) {
    const existing = (await listStudioProjects()).find(
      (project) => project.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (existing) return existing
  }

  // Studio accepts source documents directly. A plain-text document is the
  // least lossy representation here: it contains only narration, with one
  // paragraph per storyboard frame and no visual-direction text.
  const form = new FormData()
  form.append('name', name)
  form.append(
    'from_document',
    new Blob([paragraphs.join('\n\n')], { type: 'text/plain;charset=utf-8' }),
    `${name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'voiceover'}_VO.txt`,
  )
  if (process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim()) {
    form.append('default_paragraph_voice_id', process.env.ELEVENLABS_DEFAULT_VOICE_ID.trim())
  }
  if (process.env.ELEVENLABS_DEFAULT_MODEL_ID?.trim()) {
    form.append('default_model_id', process.env.ELEVENLABS_DEFAULT_MODEL_ID.trim())
  }

  const body = await request('/studio/projects', { method: 'POST', body: form })
  const project = body?.project || body
  const id = String(project?.project_id || '').trim()
  if (!id) throw new Error('ElevenLabs created the Studio project but returned no project id')
  return { id, name: String(project?.name || name), url: studioProjectUrl(id) }
}
