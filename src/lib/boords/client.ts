// @ts-nocheck
/**
 * Boords v1 API Client
 *
 * Spec: https://app.boords.com — Public API v1 (OpenAPI 3.0.1)
 * Auth: X-API-KEY header. Tokens have a "bap_" prefix and are per-user.
 *
 * Required env vars:
 *   BOORDS_API_KEY — token from Settings → Team → API
 *
 * Optional env vars:
 *   BOORDS_TEAM_ID            — short Team hashid. Skips the GET /me call
 *                               on the auto-create-project path.
 *   BOORDS_DEFAULT_PROJECT_ID — short Project hashid. When set, every new
 *                               storyboard lands here and no project is
 *                               created. Used only if you want a single
 *                               shared bucket.
 *
 * Default behavior (no env overrides): each storyboard creates its own
 * Boords project named after the storyboard, then drops the storyboard
 * inside it.
 *
 * Resource model: Team → Project → Storyboard → Frames → Comments.
 *
 * JSON:API envelope: every request body must be wrapped in `{ data: {...} }`.
 * Every response is `{ data: {...}, meta?: {...} }`.
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
    // Fresh timeout signal — the original AbortSignal.timeout(15s) has very
    // likely fired during the wait (Retry-After up to 30s), which would abort
    // the retry immediately instead of actually retrying.
    res = await fetch(url.toString(), { ...init, signal: AbortSignal.timeout(15_000) })
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
 * Per-frame payload sent to POST /v1/storyboards in script-import mode.
 * `label` becomes the frame's `reference` (the small caption). Any other
 * string key becomes a custom field — Boords builds the field schema on
 * the fly and echoes the generated field IDs in `meta.field_key_map`.
 *
 * We use `sound` for VO/narration and `action` for visuals to match the
 * conventional A/V table headers.
 */
export interface BoordsFrame {
  label?: string
  sound?: string
  action?: string
  dialogue?: string
  notes?: string
  /** Display-only — Boords doesn't store per-frame duration. */
  duration?: number
}

export interface CreateStoryboardInput {
  name: string
  /** Override the auto-create flow and drop the storyboard into this project. */
  projectId?: string
  /** Description for the auto-created Boords project (ignored when projectId given). */
  description?: string
  /** Accepts "16:9" or "16x9" — we normalize to Boords' "16x9" form. */
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5' | '21:9' | string
  frames: BoordsFrame[]
}

// ─── Endpoints ─────────────────────────────────────────────────

/**
 * Resolve the team hashid for project creation. Cached for the process.
 *
 * Order:
 *   1. BOORDS_TEAM_ID env override
 *   2. GET /v1/me → meta.teams[0].id
 *
 * GET /v1/me is the official way to discover teams: it works on any
 * valid token (no special role required), and the spec documents the
 * `meta.teams` array on its response.
 */
let _cachedTeamId: string | null = null
export async function getCurrentTeamId(): Promise<string> {
  if (_cachedTeamId) return _cachedTeamId
  const fromEnv = process.env.BOORDS_TEAM_ID?.trim()
  if (fromEnv) {
    _cachedTeamId = fromEnv
    return fromEnv
  }
  const res = await boordsFetch('GET', '/me')
  const teams = (res?.meta?.teams || []) as Array<{ id: string; name?: string; role?: string }>
  if (teams.length === 0) {
    throw new Error(
      'GET /v1/me returned no teams. Set BOORDS_TEAM_ID in Railway with your team\'s short hashid.',
    )
  }
  // Prefer a team where the user has create-project permissions.
  const writable = teams.find((t) =>
    ['admin', 'manager', 'supermember'].includes((t.role || '').toLowerCase()),
  )
  const chosen = writable || teams[0]
  _cachedTeamId = chosen.id
  return chosen.id
}

/**
 * Create a Boords project under the resolved team.
 * POST /v1/projects with body `{ data: { name, team_id, description? } }`.
 * Requires admin/manager/supermember role on the team.
 */
export async function createProject(input: {
  name: string
  description?: string
  teamId?: string
}): Promise<BoordsProject> {
  const teamId = input.teamId || (await getCurrentTeamId())
  const body: Record<string, unknown> = { name: input.name, team_id: teamId }
  if (input.description) body.description = input.description
  const res = await boordsFetch('POST', '/projects', { data: body })
  const data = res?.data || {}
  return {
    id: data.id,
    name: data?.attributes?.name || input.name,
  }
}

/**
 * Normalize aspect ratio strings to Boords' "WxH" format ("16x9" not "16:9").
 */
function normalizeAspectRatio(raw?: string): string | undefined {
  if (!raw) return undefined
  return raw.replace(':', 'x')
}

/**
 * Frame payload for storyboard create (script-import mode). The spec
 * accepts `label` plus arbitrary string properties; we keep our four
 * conventional fields and drop anything non-string (Boords ignores
 * unknown numeric props but it's cleaner to send a clean payload).
 */
function buildFramesPayload(frames: BoordsFrame[]): any[] {
  return frames.map((f, i) => {
    const out: Record<string, string> = { label: f.label ?? String(i + 1) }
    if (f.sound) out.sound = String(f.sound)
    if (f.action) out.action = String(f.action)
    if (f.dialogue) out.dialogue = String(f.dialogue)
    if (f.notes) out.notes = String(f.notes)
    return out
  })
}

/**
 * Create a storyboard. The flow:
 *   1. Resolve a project: explicit → env default → auto-create (new project).
 *   2. POST /v1/storyboards in script-import mode with all frames inline.
 *
 * Returns the new storyboard's hashid, public URL, and the field-key map
 * Boords echoes (so callers can later PATCH fields by their generated ID).
 */
export async function createStoryboard(input: CreateStoryboardInput): Promise<{
  storyboard: BoordsStoryboard
  project: BoordsProject
  fieldKeyMap: Record<string, string>
}> {
  // ── Resolve project ──────────────────────────────────────────
  let project: BoordsProject
  const explicitProjectId =
    input.projectId || process.env.BOORDS_DEFAULT_PROJECT_ID?.trim()
  if (explicitProjectId) {
    project = { id: explicitProjectId, name: '' }
  } else {
    project = await createProject({
      name: input.name,
      description: input.description,
    })
  }

  // ── Create storyboard ────────────────────────────────────────
  const body: Record<string, unknown> = {
    name: input.name,
    project_id: project.id,
    frames: buildFramesPayload(input.frames),
  }
  const ar = normalizeAspectRatio(input.aspectRatio)
  if (ar) body.frame_aspect_ratio = ar

  const res = await boordsFetch('POST', '/storyboards', { data: body })
  const data = res?.data || {}
  const attrs = data?.attributes || {}

  return {
    storyboard: {
      id: data.id,
      name: attrs.name || input.name,
      url: attrs.public_url || attrs.edit_url,
      frameCount: input.frames.length,
    },
    project,
    fieldKeyMap: res?.meta?.field_key_map || {},
  }
}

/**
 * Append additional frames to an existing storyboard, one per call.
 * POST /v1/storyboards/{storyboardId}/frames with body
 *   `{ data: { reference, field_data: { sound, action, ... }, position: "end" } }`.
 *
 * Used by `/storyboard resume` when the initial create succeeded but a
 * follow-up call left the storyboard incomplete.
 */
export async function appendFrames(
  storyboardId: string,
  frames: BoordsFrame[],
  startLabelOffset = 0,
): Promise<void> {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const fieldData: Record<string, string> = {}
    if (f.sound) fieldData.sound = String(f.sound)
    if (f.action) fieldData.action = String(f.action)
    if (f.dialogue) fieldData.dialogue = String(f.dialogue)
    if (f.notes) fieldData.notes = String(f.notes)
    await boordsFetch('POST', `/storyboards/${storyboardId}/frames`, {
      data: {
        reference: f.label ?? String(startLabelOffset + i + 1),
        field_data: fieldData,
        position: 'end',
      },
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
    url: s?.attributes?.public_url || s?.attributes?.edit_url,
  }))
}
