import type { ControlCenterAccess } from '../control-center/access'
import { WORLD_AGENTS } from './catalog'
import { explainWorld } from './model'
import type { WorldSnapshot } from './types'

type Ports = {
  access: () => Promise<ControlCenterAccess | null>
  load: (args: { workspaceId: string; workspaceName: string }) => Promise<WorldSnapshot>
}
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

async function readQuestion(request: Request): Promise<{ question: string; agentId?: string }> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing question')
  let size = 0, body = ''
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) throw new Error('Question too large')
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } finally { await reader.cancel().catch(() => {}) }
  const value: unknown = JSON.parse(body)
  if (!value || typeof value !== 'object') throw new Error('Missing question')
  const data = value as Record<string, unknown>
  if (typeof data.question !== 'string' || !data.question.trim() || data.question.length > 500) throw new Error('Question must be 1–500 characters')
  if (data.agentId !== undefined && !WORLD_AGENTS.some(a => a.id === data.agentId)) throw new Error('Unknown agent')
  return { question: data.question.trim(), agentId: data.agentId as string | undefined }
}

export async function handleWorld(request: Request, ports: Ports): Promise<Response> {
  try {
    const access = await ports.access()
    if (!access) return json({ error: 'Studio admin access required.' }, 403)
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Read-only endpoint.' }, 405)
    let question: Awaited<ReturnType<typeof readQuestion>> | undefined
    if (request.method === 'POST') {
      const origin = request.headers.get('origin')
      if (origin && origin !== new URL(request.url).origin) return json({ error: 'Same-origin diagnostics only.' }, 403)
      try { question = await readQuestion(request) } catch { return json({ error: 'Provide a question of at most 500 characters and a known agent.' }, 400) }
    }
    // Ignore caller-supplied workspace, principal, snapshot, session and URL fields.
    const snapshot = await ports.load({ workspaceId: access.workspaceId, workspaceName: access.workspaceName })
    return json(question ? explainWorld(snapshot, question.question, question.agentId) : snapshot)
  } catch {
    console.error('[working-world] Read-only request failed')
    return json({ error: 'Live records are unavailable. No action was taken.' }, 503)
  }
}
