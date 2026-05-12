// @ts-nocheck
/**
 * Boords v1 API Client
 *
 * Auth: X-API-KEY header. Tokens start with "bap_" and are tied to a user.
 * Env vars:
 *   BOORDS_API_KEY — token from Settings → Team → API (required)
 *   BOORDS_TEAM_ID — short Team id (e.g. "p4k9az") to scope project creates.
 *                   Optional — when missing we GET /teams and use the first
 *                   team returned, cached for the process lifetime.
 *
 * Resource model: Team → Project → Storyboard → Frames.
 * Project create MUST be scoped under a team, so the endpoint is
 *   POST /v1/teams/{teamId}/projects
 * (a flat POST /v1/projects returns 403 — Boords can't infer which team
 * the new project should belong to without it being in the URL).
 *
 * Storyboards still post flat at /v1/storyboards with project_id in the
 * body — that endpoint accepts the project's id directly.
 *
 * Project model: every storyboard lives inside a Boords project. We do
 * NOT share one "default" project across storyboards — each provision
 * call creates a fresh Boords project named after the storyboard, then
 * drops the storyboard inside it. Callers can override by passing an
 * explicit projectId.
 *
 * Rate limit: 120 req/min. We honor Retry-After on 429 with one bounded
 * retry; beyond that callers can re-call.
 */

const BASE_URL = 'https://app.boords.com/v1'

function headers() {
  const token = process.env.BOORDS_API_KEY
  if (!token) {
    throw new Error('BOORDS_API_KEY must be set')
  }
  return {
    'X-API-KEY': token,
    'X-API-CLIENT': 'kit',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

async function boordsFetch(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  const init: RequestInit = {
    method,
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  }
  if (body) init.body = JSON.stringify(body)

  let res = await fetch(url.toString(), init)

  // One bounded retry on rate limit, honoring Retry-After.
  if (res.status === 429) {
    const wait = Math.min(parseInt(res.headers.get('Retry-After') || '5', 10) || 5, 30)
    await new Promise((r) => setTimeout(r, wait * 1000))
    res = await fetch(url.toString(), init)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const errBody = await res.json()
      detail = errBody?.error?.message || errBody?.error?.code || ''
    } catch {
      detail = await res.text().catch(() => '')
    }
    throw new Error(`Boords ${method} ${path}: ${res.status} ${detail}`)
  }
  return res.json()
}

// ─── Types ─────────────────────────────────────────────────────

export interface BoordsProject {
  id: string
  name: string
}

export interface BoordsStoryboard {
  id: string
  name: string
  url?: string
  frameCount?: number
}

/**
 * Per-frame payload sent to POST /v1/storyboards. The `label` becomes the
 * frame's "reference" field; any other keys become Boords custom fields
 * (auto-detected on create). We use `sound` for VO/narration and `action`
 * for visuals to match Boords' canonical example in their docs.
 */
export interface BoordsFrame {
  label?: string
  sound?: string
  action?: string
  dialogue?: string
  notes?: string
  duration?: number
}

export interface CreateStoryboardInput {
  name: string
  projectId?: string
  description?: string
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5' | '21:9'
  frames: BoordsFrame[]
}

// ─── Endpoints ─────────────────────────────────────────────────

/**
 * Resolve the team id we should create projects under. Cached for the
 * process lifetime — the team membership doesn't change often.
 *
 * Order of resolution:
 *   1. BOORDS_TEAM_ID env var (explicit override)
 *   2. GET /teams → first team's id
 */
let _cachedTeamId: string | null = null
export async function getCurrentTeamId(): Promise<string> {
  if (_cachedTeamId) return _cachedTeamId
  const fromEnv = process.env.BOORDS_TEAM_ID?.trim()
  if (fromEnv) {
    _cachedTeamId = fromEnv
    return fromEnv
  }
  const res = await boordsFetch('GET', '/teams')
  const first = (res?.data || [])[0]
  if (!first?.id) {
    throw new Error(
      'No Boords team found for this API key. Set BOORDS_TEAM_ID or check that the token belongs to a team.',
    )
  }
  _cachedTeamId = first.id
  return first.id
}

/**
 * Create a new Boords project under the resolved team. We make one per
 * storyboard so each Ranger & Fox project gets its own Boords project
 * (no shared bucket).
 */
export async function createProject(input: { name: string }): Promise<BoordsProject> {
  const teamId = await getCurrentTeamId()
  const res = await boordsFetch('POST', `/teams/${teamId}/projects`, {
    name: input.name,
  })
  const data = res?.data || {}
  return {
    id: data.id,
    name: data?.attributes?.name || input.name,
  }
}

/**
 * Create a storyboard with all its frames in a single POST.
 * The docs explicitly support this pattern via the `frames` array.
 *
 * If no `projectId` is passed we first create a fresh Boords project
 * named after the storyboard — every storyboard gets its own project.
 *
 * Returns the new storyboard's ID and (if present) a viewable URL,
 * plus the field_key_map echo so callers can update fields later.
 */
export async function createStoryboard(input: CreateStoryboardInput): Promise<{
  storyboard: BoordsStoryboard
  project: BoordsProject
  fieldKeyMap: Record<string, string>
}> {
  let projectId = input.projectId
  let project: BoordsProject
  if (!projectId) {
    project = await createProject({ name: input.name })
    projectId = project.id
  } else {
    project = { id: projectId, name: '' }
  }

  const body: Record<string, unknown> = {
    name: input.name,
    project_id: projectId,
    frames: input.frames.map((f, i) => ({
      label: f.label ?? String(i + 1),
      ...(f.sound !== undefined ? { sound: f.sound } : {}),
      ...(f.action !== undefined ? { action: f.action } : {}),
      ...(f.dialogue !== undefined ? { dialogue: f.dialogue } : {}),
      ...(f.notes !== undefined ? { notes: f.notes } : {}),
      ...(f.duration !== undefined ? { duration: f.duration } : {}),
    })),
  }
  if (input.description) body.description = input.description
  if (input.aspectRatio) body.aspect_ratio = input.aspectRatio

  const res = await boordsFetch('POST', '/storyboards', body)
  const data = res?.data || {}
  const attrs = data?.attributes || {}
  return {
    storyboard: {
      id: data.id,
      name: attrs.name || input.name,
      url: attrs.url || attrs.share_url || attrs.viewer_url,
      frameCount: input.frames.length,
    },
    project,
    fieldKeyMap: res?.meta?.field_key_map || {},
  }
}

/**
 * Append additional frames to an existing storyboard. Used by the resume
 * flow when an initial create succeeded for some frames but failed before
 * Boords accepted the rest.
 */
export async function appendFrames(
  storyboardId: string,
  frames: BoordsFrame[],
  startLabelOffset = 0,
): Promise<void> {
  // The docs reference a frame-creation endpoint; conservatively use one
  // call per frame. Rate-limit headers will signal if we need to throttle.
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    await boordsFetch('POST', `/storyboards/${storyboardId}/frames`, {
      label: f.label ?? String(startLabelOffset + i + 1),
      ...(f.sound !== undefined ? { sound: f.sound } : {}),
      ...(f.action !== undefined ? { action: f.action } : {}),
      ...(f.dialogue !== undefined ? { dialogue: f.dialogue } : {}),
      ...(f.notes !== undefined ? { notes: f.notes } : {}),
      ...(f.duration !== undefined ? { duration: f.duration } : {}),
    })
  }
}

export async function listProjects(limit = 50): Promise<BoordsProject[]> {
  const res = await boordsFetch('GET', '/projects', undefined, { limit: String(limit) })
  return (res?.data || []).map((p: any) => ({
    id: p.id,
    name: p?.attributes?.name || p.id,
  }))
}

export async function listStoryboards(
  projectId?: string,
  limit = 50,
): Promise<BoordsStoryboard[]> {
  const params: Record<string, string> = { limit: String(limit) }
  if (projectId) params.project_id = projectId
  const res = await boordsFetch('GET', '/storyboards', undefined, params)
  return (res?.data || []).map((s: any) => ({
    id: s.id,
    name: s?.attributes?.name || s.id,
    url: s?.attributes?.url,
  }))
}
