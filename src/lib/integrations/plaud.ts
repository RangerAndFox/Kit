// @ts-nocheck
/**
 * Plaud personal-recording API client.
 *
 * This uses the OAuth API shipped behind Plaud's official CLI/MCP products,
 * not the Plaud Embedded API (which only transcribes audio an app uploads).
 * OAuth state is coordinated through Supabase so refresh-token rotation is
 * safe across concurrent Vercel instances.
 *
 * Official product docs: https://docs.plaud.ai/plaud-mcp-cli/cli
 */

import { createAdminClient } from '../supabase/admin'

const DEFAULT_API_BASE = 'https://platform.plaud.ai/developer/api'
const DEFAULT_REFRESH_URL = `${DEFAULT_API_BASE}/oauth/third-party/access-token/refresh`
const SAFETY_BUFFER_MS = 60_000
const LOCK_TTL_MS = 30_000
const MAX_TOKEN_ATTEMPTS = 6
const WAIT_MS = 500

export interface PlaudSourceBlock {
  data_type?: string
  data_content?: string
  data_link?: string
}

export interface PlaudRecording {
  id: string
  name?: string
  created_at?: string
  start_at?: string
  duration?: number
  serial_number?: string
  source_list?: PlaudSourceBlock[]
  note_list?: PlaudSourceBlock[]
}

interface PlaudListResponse {
  data: PlaudRecording[]
  page?: number
}

interface TokenRow {
  refresh_token: string | null
  access_token: string | null
  access_expires_at: string | null
  refreshing_until: string | null
}

interface AccessSnapshot {
  accessToken: string
  expiresAt: number
}

let cachedAccess: AccessSnapshot | null = null

export function plaudIngestEnabled(): boolean {
  return process.env.PLAUD_INGEST_ENABLED === 'true'
}

function apiBase(): string {
  return process.env.PLAUD_API_BASE?.replace(/\/$/, '') || DEFAULT_API_BASE
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readTokenState(): Promise<TokenRow | null> {
  const { data, error } = await createAdminClient()
    .from('plaud_token_state')
    .select('refresh_token, access_token, access_expires_at, refreshing_until')
    .eq('id', 'singleton')
    .maybeSingle()
  if (error) throw new Error(`plaud_token_state read failed: ${error.message}`)
  return (data as TokenRow) || null
}

function usableAccess(row: TokenRow | null, now = Date.now()): string | null {
  if (!row?.access_token || !row.access_expires_at) return null
  const expiresAt = Date.parse(row.access_expires_at)
  if (Number.isNaN(expiresAt) || now >= expiresAt - SAFETY_BUFFER_MS) return null
  return row.access_token
}

async function claimRefreshLock(): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const untilIso = new Date(Date.now() + LOCK_TTL_MS).toISOString()
  const { data, error } = await createAdminClient()
    .from('plaud_token_state')
    .update({ refreshing_until: untilIso, updated_at: nowIso })
    .eq('id', 'singleton')
    .or(`refreshing_until.is.null,refreshing_until.lt.${nowIso}`)
    .select('id')
  if (error) throw new Error(`Plaud refresh-lock claim failed: ${error.message}`)
  return Array.isArray(data) && data.length === 1
}

async function ensureBootstrapRow(): Promise<void> {
  const refreshToken = process.env.PLAUD_REFRESH_TOKEN?.trim()
  if (!refreshToken) {
    throw new Error('PLAUD_REFRESH_TOKEN is required when PLAUD_INGEST_ENABLED=true')
  }
  const { error } = await createAdminClient().from('plaud_token_state').upsert(
    { id: 'singleton', refresh_token: refreshToken, updated_at: new Date().toISOString() },
    { onConflict: 'id', ignoreDuplicates: true },
  )
  if (error) throw new Error(`Plaud token bootstrap failed: ${error.message}`)
}

async function releaseLockQuietly(): Promise<void> {
  try {
    await createAdminClient()
      .from('plaud_token_state')
      .update({ refreshing_until: null, updated_at: new Date().toISOString() })
      .eq('id', 'singleton')
  } catch {}
}

async function invalidateAccessTokenQuietly(): Promise<void> {
  cachedAccess = null
  try {
    await createAdminClient()
      .from('plaud_token_state')
      .update({ access_token: null, access_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', 'singleton')
  } catch {}
}

async function exchangeAndPersist(): Promise<AccessSnapshot> {
  const state = await readTokenState()
  const refreshToken = state?.refresh_token || process.env.PLAUD_REFRESH_TOKEN?.trim()
  if (!refreshToken) throw new Error('Plaud refresh token is unavailable')

  const refreshUrl = process.env.PLAUD_REFRESH_URL || DEFAULT_REFRESH_URL
  const res = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Plaud token refresh failed: ${res.status} ${detail}`)
  }
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token) throw new Error('Plaud token refresh returned no access_token')

  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600
  const expiresAt = new Date(Date.now() + expiresIn * 1000)
  const nextRefresh = data.refresh_token || refreshToken
  const { error } = await createAdminClient().from('plaud_token_state').upsert(
    {
      id: 'singleton',
      refresh_token: nextRefresh,
      access_token: data.access_token,
      access_expires_at: expiresAt.toISOString(),
      refreshing_until: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )
  if (error) {
    throw new Error(
      `Plaud refreshed successfully but token persistence failed (${error.message}); re-authorize Plaud before retrying.`,
    )
  }
  return { accessToken: data.access_token, expiresAt: expiresAt.getTime() - SAFETY_BUFFER_MS }
}

export async function getPlaudAccessToken(): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.accessToken
  await ensureBootstrapRow()

  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const state = await readTokenState()
    const shared = usableAccess(state)
    if (shared) {
      cachedAccess = {
        accessToken: shared,
        expiresAt: Date.parse(state!.access_expires_at as string) - SAFETY_BUFFER_MS,
      }
      return shared
    }

    if (await claimRefreshLock()) {
      try {
        const fresh = await readTokenState()
        const freshShared = usableAccess(fresh)
        if (freshShared) {
          await releaseLockQuietly()
          return freshShared
        }
        cachedAccess = await exchangeAndPersist()
        return cachedAccess.accessToken
      } catch (error) {
        await releaseLockQuietly()
        throw error
      }
    }
    await sleep(WAIT_MS * (attempt + 1))
  }
  throw new Error('Plaud token refresh remained locked; retry on the next scan')
}

async function plaudRequest<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getPlaudAccessToken()
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return (await res.json()) as T
    if (res.status === 401 && attempt === 0) {
      await invalidateAccessTokenQuietly()
      continue
    }
    const detail = await res.text().catch(() => '')
    throw new Error(`Plaud API ${path} failed: ${res.status} ${detail}`)
  }
  throw new Error(`Plaud API ${path} failed after token refresh`)
}

export async function listPlaudRecordings(page = 1, pageSize = 50): Promise<PlaudRecording[]> {
  const result = await plaudRequest<PlaudListResponse>(
    `/open/third-party/files/?page=${page}&page_size=${pageSize}`,
  )
  return Array.isArray(result.data) ? result.data : []
}

export async function getPlaudRecording(fileId: string): Promise<PlaudRecording> {
  return plaudRequest<PlaudRecording>(`/open/third-party/files/${encodeURIComponent(fileId)}`)
}

/**
 * Fail-closed historical frontier. Direct and Drive ids differ, so importing
 * all Plaud history would duplicate transcripts already ingested through the
 * old Zap. Operators set this to the first missing recording date at cutover.
 */
export function filterPlaudRecordingsSince(
  recordings: PlaudRecording[],
  sinceValue = process.env.PLAUD_INGEST_FROM,
): PlaudRecording[] {
  if (!sinceValue) throw new Error('PLAUD_INGEST_FROM is required when PLAUD_INGEST_ENABLED=true')
  const since = Date.parse(sinceValue)
  if (Number.isNaN(since)) throw new Error('PLAUD_INGEST_FROM must be a valid ISO-8601 timestamp')
  return recordings.filter((recording) => {
    const created = Date.parse(recording.start_at || recording.created_at || '')
    return Number.isFinite(created) && created >= since
  })
}

export async function loadPlaudBlock(block?: PlaudSourceBlock): Promise<string> {
  if (!block) return ''
  if (typeof block.data_content === 'string' && block.data_content.length > 0) {
    return block.data_content
  }
  if (typeof block.data_link === 'string' && block.data_link.length > 0) {
    const res = await fetch(block.data_link, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`Plaud transcript block download failed: ${res.status}`)
    return res.text()
  }
  return ''
}

export interface ParsedPlaudTranscript {
  text: string
  participants: Array<{ name: string }>
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/** Parse Plaud's transaction/transaction_polish JSON into searchable text. */
export function parsePlaudTranscriptContent(content: string): ParsedPlaudTranscript {
  const trimmed = content.trim()
  if (!trimmed) return { text: '', participants: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { text: trimmed, participants: [] }
  }
  if (!Array.isArray(parsed)) return { text: trimmed, participants: [] }

  const speakers = new Set<string>()
  const lines = parsed
    .map((segment: any) => {
      const body = String(segment?.content ?? segment?.text ?? segment?.topic ?? '').trim()
      if (!body) return ''
      const speaker = String(segment?.speaker ?? segment?.speaker_label ?? '').trim()
      if (speaker) speakers.add(speaker)
      const start = Number(segment?.start_time ?? segment?.start)
      const time = Number.isFinite(start) ? `[${formatClock(start)}] ` : ''
      return `${time}${speaker ? `${speaker}: ` : ''}${body}`
    })
    .filter(Boolean)

  return {
    text: lines.join('\n'),
    participants: [...speakers].map((name) => ({ name })),
  }
}

/** Prefer Plaud's cleaned transcript, then fall back to the raw transcript. */
export async function extractPlaudTranscript(recording: PlaudRecording): Promise<ParsedPlaudTranscript> {
  const blocks = recording.source_list || []
  const polished = blocks.find((block) => block.data_type === 'transaction_polish')
  if (polished) {
    const parsed = parsePlaudTranscriptContent(await loadPlaudBlock(polished))
    if (parsed.text) return parsed
  }
  const raw = blocks.find((block) => block.data_type === 'transaction')
  return parsePlaudTranscriptContent(await loadPlaudBlock(raw))
}
