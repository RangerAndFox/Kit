// @ts-nocheck
/**
 * Boords v1 API Client
 *
 * Auth: X-API-KEY header. Tokens start with "bap_" and are tied to a user.
 * Env vars:
 *   BOORDS_API_KEY            — token from Settings → Team → API (required)
 *   BOORDS_DEFAULT_PROJECT_ID — short Project id (e.g. "p4k9az"). Optional.
 *                               When set, every new storyboard lands inside
 *                               this project — useful when the token is
 *                               project-scoped and can't create new
 *                               projects on the fly (the common case).
 *   BOORDS_TEAM_ID            — short Team id. Optional. Only used by the
 *                               auto-create-project path when no default
 *                               project is set. Avoids a GET /teams hop.
 *
 * Resource model: Team → Project → Storyboard → Frames.
 *
 * Project resolution order in createStoryboard:
 *   1. Explicit projectId argument (per-call override)
 *   2. BOORDS_DEFAULT_PROJECT_ID env var (one bucket for all storyboards)
 *   3. Auto-create a fresh project under the resolved team
 *      (POST /v1/teams/{teamId}/projects) — only works if the token has
 *      team-admin scope. If your token is project-scoped (the default),
 *      this returns 403 and you should set BOORDS_DEFAULT_PROJECT_ID.
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

/** Shape the frames payload identically across all create paths. */
function buildFramesPayload(frames: BoordsFrame[]): any[] {
  return frames.map((f, i) => ({
    label: f.label ?? String(i + 1),
    ...(f.sound !== undefined ? { sound: f.sound } : {}),
    ...(f.action !== undefined ? { action: f.action } : {}),
    ...(f.dialogue !== undefined ? { dialogue: f.dialogue } : {}),
    ...(f.notes !== undefined ? { notes: f.notes } : {}),
    ...(f.duration !== undefined ? { duration: f.duration } : {}),
  }))
}

function parseStoryboardResponse(
  res: any,
  fallbackName: string,
  frameCount: number,
  projectIdHint?: string,
): {
  storyboard: BoordsStoryboard
  project: BoordsProject
  fieldKeyMap: Record<string, string>
} {
  const data = res?.data || {}
  const attrs = data?.attributes || {}
  const projectId =
    projectIdHint ||
    attrs.project_id ||
    data?.relationships?.project?.data?.id ||
    ''
  return {
    storyboard: {
      id: data.id,
      name: attrs.name || fallbackName,
      url: attrs.url || attrs.share_url || attrs.viewer_url,
      frameCount,
    },
    project: { id: projectId, name: attrs.project_name || '' },
    fieldKeyMap: res?.meta?.field_key_map || {},
  }
}

/**
 * Create a storyboard with all its frames in a single POST.
 *
 * Project resolution — we try the cheapest path first and fall back as
 * each one fails so a project-scoped token still works without manual
 * setup whenever Boords' API allows it:
 *
 *   1. Explicit input.projectId → POST /storyboards with project_id
 *   2. BOORDS_DEFAULT_PROJECT_ID env var → same
 *   3. Inline create: POST /storyboards with project_name (no project_id)
 *      — Boords spins up a new project named project_name as a side effect.
 *      Works with project-scoped tokens because no /projects call is made.
 *   4. Explicit project create: POST /projects → POST /storyboards
 *      — only works if the token has team-admin scope (rare).
 *
 * Whichever path succeeds first wins. Errors are aggregated so the final
 * thrown error explains every attempt.
 */
export async function createStoryboard(input: CreateStoryboardInput): Promise<{
  storyboard: BoordsStoryboard
  project: BoordsProject
  fieldKeyMap: Record<string, string>
}> {
  const frames = buildFramesPayload(input.frames)
  const baseBody: Record<string, unknown> = { name: input.name, frames }
  if (input.description) baseBody.description = input.description
  if (input.aspectRatio) baseBody.aspect_ratio = input.aspectRatio

  // ── Path 1 & 2: explicit projectId or env default ────────────
  const explicitProjectId =
    input.projectId || process.env.BOORDS_DEFAULT_PROJECT_ID?.trim()
  if (explicitProjectId) {
    const res = await boordsFetch('POST', '/storyboards', {
      ...baseBody,
      project_id: explicitProjectId,
    })
    return parseStoryboardResponse(
      res,
      input.name,
      input.frames.length,
      explicitProjectId,
    )
  }

  // ── Path 3: inline create via storyboard endpoint ────────────
  // Pass project_name so Boords auto-creates a project. If the API
  // doesn't honor this field it'll error 4xx and we move on.
  const attempts: Array<{ path: string; error: string }> = []
  try {
    const res = await boordsFetch('POST', '/storyboards', {
      ...baseBody,
      project_name: input.name,
    })
    return parseStoryboardResponse(res, input.name, input.frames.length)
  } catch (err: any) {
    attempts.push({ path: 'POST /storyboards (project_name)', error: err.message })
  }

  // ── Path 4: explicit POST /projects then POST /storyboards ───
  try {
    const project = await createProject({ name: input.name })
    const res = await boordsFetch('POST', '/storyboards', {
      ...baseBody,
      project_id: project.id,
    })
    return parseStoryboardResponse(res, input.name, input.frames.length, project.id)
  } catch (err: any) {
    attempts.push({ path: 'POST /projects → /storyboards', error: err.message })
  }

  const detail = attempts.map((a) => `${a.path}: ${a.error}`).join(' | ')
  throw new Error(
    `Couldn't create a Boords project for "${input.name}". Tried: ${detail}. ` +
      `If your token is project-scoped, set BOORDS_DEFAULT_PROJECT_ID in Railway.`,
  )
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
