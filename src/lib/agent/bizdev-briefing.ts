// @ts-nocheck
/**
 * Bizdev briefing — the meeting composer used when a calendar event doesn't
 * match any active project but a bizdev-role staffer (e.g. Erin) is on the
 * invite. Instead of project context, it looks up each external attendee on
 * the web and writes a short bio + relevance to Ranger & Fox.
 *
 * Delivery follows the same privacy rule as project briefings: only R&F
 * attendees actually on the invite receive it (see matchAttendeesToStaff in
 * briefing-composer.ts), via their private per-person channel.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import { searchDocuments } from '@/lib/rag/query'
import type { CalendarEvent } from '@/lib/integrations/google-calendar'
import { matchAttendeesToStaff, fmtTime, type BriefingRecipient } from './briefing-composer'

export interface BizdevBriefingArtifact {
  channelText: string
  recipients: BriefingRecipient[]
}

// ─── Normalized evidence contract ─────────────────────────────
//
// Research NEVER returns raw prose to composition. It returns this normalized
// object, and composition renders only its structured fields. This structurally
// prevents a conversational model reply ("I'd be happy to help… I need a name")
// from ever reaching a delivered briefing: non-JSON output fails to parse and
// degrades to an `unresolved` result, not verbatim prose.

export type IdentityStatus = 'resolved' | 'likely' | 'unresolved'

export interface AttendeeEvidence {
  identity: {
    status: IdentityStatus
    name: string | null
    company: string | null
    /** The signals that generated this identity guess (candidates, not proof). */
    candidates: { value: string; from: string }[]
  }
  /** Corroborated facts, each ideally citing a source. */
  facts: { claim: string; source_ref: string | null }[]
  /** Reasonable inferences, explicitly labelled as such (not fact). */
  inferences: { claim: string; basis: string | null }[]
  /** Known-absent fields (drives the "missing" note, not a guess). */
  missing: string[]
  sources: { ref: string; kind: string }[]
}

/**
 * True if any attendee email (or alias) belongs to a bizdev-role staffer.
 * Pure — unit-tested. Gates the whole bizdev path: without a bizdev staffer
 * on the invite, an unmatched meeting stays silently skipped as before.
 */
export function hasBizdevAttendee(
  attendeeEmails: string[],
  bizdevEmails: Set<string>,
): boolean {
  return attendeeEmails.some((e) => bizdevEmails.has((e || '').trim().toLowerCase()))
}

// Parenthetical values that are NOT a company (meeting-logistics noise). Kept
// small; anything else in "(...)" is treated as a company candidate.
const TITLE_PAREN_STOPWORDS = new Set([
  'zoom', 'meet', 'google meet', 'teams', 'internal', 'tentative', 'rescheduled',
  'canceled', 'cancelled', 'remote', 'virtual', 'hold', 'on hold', 'wip', '1:1',
  'no agenda', 'recurring', 'optional', 'tbd',
])

/**
 * Company candidate from a meeting title's parenthetical, e.g.
 * "R&F + Steve (Kit Inc)" → "Kit Inc". Returns null when the parenthetical is
 * absent or is meeting-logistics noise. Pure — unit-tested.
 */
export function companyFromTitle(title: string): string | null {
  const m = (title || '').match(/\(([^)]+)\)/)
  if (!m) return null
  const inner = m[1].trim()
  if (inner.length < 2 || !/[a-zA-Z]/.test(inner)) return null
  if (TITLE_PAREN_STOPWORDS.has(inner.toLowerCase())) return null
  return inner
}

// Explicit business-development / project-inquiry language. Deliberately does
// NOT include interview/recruiting/personal terms.
const BIZDEV_TITLE_PATTERNS: RegExp[] = [
  /\bintro(duction)?\b/, /\bbiz\s?dev\b/, /\bbusiness development\b/,
  /\bproposal\b/, /\bpitch\b/, /\bprospect\b/, /\bdiscovery\b/,
  /\bkick[\s-]?off\b/, /\bsow\b/, /\bstatement of work\b/, /\bscope\b/,
  /\bnew project\b/, /\b(project )?inquiry\b/, /\brfp\b/, /\bpartnership\b/,
]

/** True if the title uses explicit bizdev / project-inquiry language. Pure. */
export function hasBizdevLanguage(title: string): boolean {
  const t = (title || '').toLowerCase()
  return BIZDEV_TITLE_PATTERNS.some((re) => re.test(t))
}

/**
 * At least one POSITIVE business-context signal, using the smallest existing
 * evidence mechanisms. Attendee topology alone is not enough — this is what
 * separates a real bizdev call from a recruiter/vendor/personal call. Pure —
 * unit-tested. Consumer domains (gmail/outlook/…) are NOT company evidence
 * (parseCompanyFromDomain returns null for them).
 */
export function hasBusinessContextSignal(opts: {
  title: string
  externalEmails: string[]
}): boolean {
  if ((opts.externalEmails || []).some((e) => parseCompanyFromDomain(e) !== null)) return true
  if (companyFromTitle(opts.title)) return true
  if (hasBizdevLanguage(opts.title)) return true
  return false
}

// Recruiting / interview context. Deliberately NARROW — only unambiguous
// recruiting terms. A recruiting call can come from a real corporate domain, so
// this must veto the positive signals for the general fallback (but never the
// role=bizdev override). Not extended to vendor/accountant/personal — those are
// ambiguous and out of scope.
const RECRUITING_TITLE_PATTERNS: RegExp[] = [
  /\binterview\b/, /\brecruiter\b/, /\brecruiting\b/,
]

/** True if the title is a recruiting/interview conversation. Pure — unit-tested. */
export function hasRecruitingContext(title: string): boolean {
  const t = (title || '').toLowerCase()
  return RECRUITING_TITLE_PATTERNS.some((re) => re.test(t))
}

/**
 * Decide whether a meeting with NO active-project match should still be briefed
 * as business development. Pure — unit-tested.
 *
 * Precedence (evaluated in this order):
 *   1. role=bizdev override — a bizdev-role staffer on the invite is always
 *      bizdev (recruiting exclusion does NOT apply here).
 *   2. Topology required — otherwise, need ≥1 matched internal staff attendee
 *      AND ≥1 external attendee; else skip.
 *   3. Recruiting exclusion — an interview/recruiter/recruiting title is skipped
 *      even if it has a corporate domain or other positive signal.
 *   4. Positive business-context signal — non-generic company domain, a company
 *      candidate in the title, or explicit bizdev language; else skip.
 */
export function shouldBriefAsBizdev(opts: {
  hasBizdevRoleAttendee: boolean
  internalMatchCount: number
  externalCount: number
  title: string
  externalEmails: string[]
}): boolean {
  // 1. role=bizdev override.
  if (opts.hasBizdevRoleAttendee) return true
  // 2. Topology required.
  if (!(opts.internalMatchCount >= 1 && opts.externalCount >= 1)) return false
  // 3. Recruiting exclusion — applied BEFORE positive signals are accepted.
  if (hasRecruitingContext(opts.title)) return false
  // 4. Positive business-context signal.
  return hasBusinessContextSignal({ title: opts.title, externalEmails: opts.externalEmails })
}

/** Builds the lowercased (email + aliases) set for a set of staff rows. Pure. */
export function buildStaffEmailSet(
  staff: { email: string | null; email_aliases?: string[] | null }[],
): Set<string> {
  const set = new Set<string>()
  for (const s of staff) {
    if (s.email) set.add(s.email.trim().toLowerCase())
    for (const alias of s.email_aliases || []) {
      if (alias && alias.trim()) set.add(alias.trim().toLowerCase())
    }
  }
  return set
}

/**
 * Attendees who are NOT internal R&F staff — the people we look up. Pure —
 * unit-tested. Uses the full staff email set (not just staff with a Slack
 * id), so an internal staffer without a Slack account is never mistaken for
 * an external contact and web-searched.
 */
export function filterExternalAttendees(
  attendees: { email: string; displayName?: string }[],
  internalEmails: Set<string>,
): { email: string; displayName?: string }[] {
  return attendees.filter((a) => {
    const email = (a.email || '').trim().toLowerCase()
    return email && !internalEmails.has(email)
  })
}

// ─── Identity resolution (candidate generation vs. verification) ──────────────

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'zoho.com',
])

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/**
 * Company CANDIDATE from an email domain — a hint for research, not a verified
 * fact. Returns null for generic consumer providers (no company signal). Pure.
 *   ryan@oshi.co        → "Oshi"
 *   x@sub.acme.co.uk    → "Acme"
 *   x@gmail.com         → null
 */
export function parseCompanyFromDomain(email: string): string | null {
  const at = (email || '').trim().toLowerCase().split('@')
  if (at.length !== 2 || !at[1]) return null
  const domain = at[1]
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null
  const labels = domain.split('.').filter(Boolean)
  if (labels.length < 2) return null
  // Drop the TLD; drop a short second-level public suffix (co.uk, com.au).
  labels.pop()
  if (labels.length >= 2 && labels[labels.length - 1].length <= 3) labels.pop()
  const reg = labels[labels.length - 1]
  return reg ? capitalize(reg) : null
}

/**
 * Person-name CANDIDATE from the meeting title, anchored on the email local
 * part so we don't pick up the studio's own name ("R&F"). Pure.
 *   ("R&F + Ryan Dolinsky (Oshi)", "ryan@oshi.co") → "Ryan Dolinsky"
 */
export function nameFromTitle(title: string, email: string): string | null {
  const local = (email || '').split('@')[0] || ''
  const first = local.split(/[._\-+]/)[0]
  if (!first || !title) return null
  const re = new RegExp(`\\b(${first}(?:\\s+[A-Z][A-Za-z'\\-]+){1,3})\\b`, 'i')
  const m = title.match(re)
  if (!m) return null
  // Title-case the matched span so a lowercased first name reads as a name.
  return m[1]
    .split(/\s+/)
    .map((w) => capitalize(w))
    .join(' ')
}

/**
 * Assemble every available identity signal into candidates. Title parsing and
 * domain parsing are candidate GENERATION only — never treated as verified.
 * Pure — unit-tested.
 */
export function buildAttendeeIdentityCandidates(opts: {
  event: CalendarEvent
  attendee: { email: string; displayName?: string }
}): { name: string | null; company: string | null; candidates: { value: string; from: string }[] } {
  const { event, attendee } = opts
  const candidates: { value: string; from: string }[] = []

  const titleName = nameFromTitle(event.summary || '', attendee.email)
  const name = attendee.displayName || titleName || null
  if (attendee.displayName) candidates.push({ value: attendee.displayName, from: 'calendar-displayName' })
  if (titleName) candidates.push({ value: titleName, from: 'meeting-title' })

  const company = parseCompanyFromDomain(attendee.email)
  if (company) candidates.push({ value: company, from: 'email-domain' })

  return { name, company, candidates }
}

/**
 * Weighted resolution status. NOT a hard "two signals" rule:
 *   - calendar-title name + company-domain email        → at least `likely`
 *   - any corroborating public/internal source          → `resolved`
 *   - a contradiction (public info disputes the guess)  → capped below resolved
 * Pure — unit-tested.
 */
export function resolveIdentityStatus(opts: {
  hasName: boolean
  hasCompany: boolean
  corroboratingSources: number
  contradiction: boolean
}): IdentityStatus {
  const strength = (opts.hasName ? 1 : 0) + (opts.hasCompany ? 1 : 0)
  if (opts.contradiction) return strength >= 2 ? 'likely' : 'unresolved'
  if (opts.corroboratingSources >= 1 && strength >= 1) return 'resolved'
  if (strength >= 2) return 'likely'
  return 'unresolved'
}

/**
 * Parse the model's response into normalized evidence. Returns null on ANY
 * shape/parse failure — the caller degrades to `unresolved`, so conversational
 * prose can never reach composition. Pure — unit-tested.
 */
export function parseAttendeeEvidence(rawText: string): {
  identity: { status?: string; name?: string | null; company?: string | null }
  facts: { claim: string; source_ref: string | null }[]
  inferences: { claim: string; basis: string | null }[]
  missing: string[]
  sources: { ref: string; kind: string }[]
  contradiction: boolean
} | null {
  const cleaned = (rawText || '')
    .replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1')
    .trim()
  if (!cleaned) return null
  let obj: any
  try {
    obj = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const arr = (v: any) => (Array.isArray(v) ? v : [])
  return {
    identity: obj.identity && typeof obj.identity === 'object' ? obj.identity : {},
    facts: arr(obj.facts)
      .filter((f: any) => f && typeof f.claim === 'string')
      .map((f: any) => ({ claim: f.claim, source_ref: f.source_ref || null })),
    inferences: arr(obj.inferences)
      .filter((f: any) => f && typeof f.claim === 'string')
      .map((f: any) => ({ claim: f.claim, basis: f.basis || null })),
    missing: arr(obj.missing).filter((s: any) => typeof s === 'string'),
    sources: arr(obj.sources)
      .filter((s: any) => s && typeof s.ref === 'string')
      .map((s: any) => ({ ref: s.ref, kind: s.kind || 'public' })),
    contradiction: obj.contradiction === true,
  }
}

/**
 * Render normalized evidence into Slack markdown lines. Consumes ONLY structured
 * fields — never raw research prose. Pure — unit-tested.
 */
export function renderAttendeeEvidence(
  ev: AttendeeEvidence,
  attendee: { email: string; displayName?: string },
): string[] {
  const name = ev.identity.name || attendee.displayName || attendee.email
  const lines: string[] = [`• *${name}* (${attendee.email})`]

  if (ev.identity.status === 'unresolved') {
    lines.push('  _No reliable public information found._')
    if (ev.missing.length) lines.push(`  _Missing: ${ev.missing.join(', ')}_`)
    return lines
  }

  const header: string[] = []
  if (ev.identity.company) header.push(`Company: ${ev.identity.company}`)
  header.push(`Confidence: ${ev.identity.status}`)
  lines.push(`  ${header.join(' · ')}`)

  for (const f of ev.facts.slice(0, 5)) lines.push(`  • ${f.claim}`)
  for (const inf of ev.inferences.slice(0, 3)) lines.push(`  • ${inf.claim} _(inferred)_`)
  if (ev.missing.length) lines.push(`  _Missing: ${ev.missing.join(', ')}_`)
  return lines
}

/**
 * Assemble the bizdev briefing markdown from normalized evidence. Pure —
 * unit-tested. A null evidence slot (research crashed) renders a fixed
 * fallback — never raw prose.
 */
export function buildBizdevBriefingText(opts: {
  event: CalendarEvent
  externals: { email: string; displayName?: string }[]
  evidence: (AttendeeEvidence | null)[]
}): string {
  const { event, externals, evidence } = opts
  const lines: string[] = []
  lines.push(':wave: *Pre-meeting briefing (business development)*')
  lines.push(`*Meeting:* ${event.summary} — ${fmtTime(event.start_time)}`)

  if (externals.length === 0) {
    lines.push('', '_No external attendees found on this invite._')
    return lines.join('\n')
  }

  lines.push('', '*Attendees:*')
  externals.forEach((a, i) => {
    const ev = evidence[i]
    if (!ev) {
      lines.push(`• *${a.displayName || a.email}* (${a.email})`, '  _No reliable info found._')
      return
    }
    for (const line of renderAttendeeEvidence(ev, a)) lines.push(line)
  })

  return lines.join('\n')
}

// ─── Internal history (authoritative R&F records) ─────────────────────────────
//
// The spec requires prior R&F contact/project history to be checked — internal
// history is a first-class input, and public research SUPPLEMENTS it. We reuse
// the canonical knowledge-search abstraction (rag/query.searchDocuments, the
// pgvector match_documents RPC) for transcripts/notes/knowledge, and add two
// authoritative structured lookups the semantic index does not cover: prior
// briefings involving this attendee, and projects matching the company. Absence
// is represented as empty history — never invented.

export interface InternalHistory {
  priorMeetings: { title: string; when: string | null }[]
  projects: { name: string; client: string | null }[]
  knowledge: { title: string; ref: string | null }[]
}

/**
 * Normalize internal history into evidence facts tagged `sources[].kind =
 * "internal"`. Pure — unit-tested. Empty history yields no facts (no invention);
 * `found` tells the caller whether to record a "missing prior history" note.
 */
export function internalHistoryToEvidence(h: InternalHistory): {
  facts: { claim: string; source_ref: string | null }[]
  sources: { ref: string; kind: string }[]
  found: boolean
} {
  const facts: { claim: string; source_ref: string | null }[] = []
  const sources: { ref: string; kind: string }[] = []
  for (const m of h.priorMeetings) {
    facts.push({ claim: `Prior R&F meeting: ${m.title}${m.when ? ` (${m.when})` : ''}`, source_ref: 'internal:meeting_briefings' })
  }
  for (const p of h.projects) {
    facts.push({ claim: `Related R&F project: ${p.name}${p.client ? ` — ${p.client}` : ''}`, source_ref: 'internal:projects' })
  }
  for (const k of h.knowledge) {
    facts.push({ claim: `Internal note: ${k.title}`, source_ref: k.ref || 'internal:knowledge' })
  }
  if (h.priorMeetings.length) sources.push({ ref: 'meeting_briefings', kind: 'internal' })
  if (h.projects.length) sources.push({ ref: 'projects', kind: 'internal' })
  if (h.knowledge.length) sources.push({ ref: 'knowledge-base', kind: 'internal' })
  return { facts, sources, found: facts.length > 0 }
}

/**
 * Retrieve prior R&F history for an external attendee from the authoritative
 * internal records. Each lookup is best-effort (a subsystem hiccup degrades to
 * empty, never blocks the briefing). One bounded read per source — this runs per
 * dispatch, not as a scan.
 */
export async function retrieveInternalHistory(opts: {
  event: CalendarEvent
  attendee: { email: string; displayName?: string }
  company: string | null
  workspaceId?: string | null
  /** Injectable for tests; defaults to the real admin client / canonical search. */
  sb?: any
  search?: typeof searchDocuments
}): Promise<InternalHistory> {
  const email = (opts.attendee.email || '').trim().toLowerCase()
  const out: InternalHistory = { priorMeetings: [], projects: [], knowledge: [] }
  const sb = opts.sb || createAdminClient()
  const search = opts.search || searchDocuments

  // 1. Prior meetings/briefings that had this attendee on the invite.
  try {
    const { data } = await sb
      .from('meeting_briefings')
      .select('meeting_title, meeting_start_time, attendees_json')
      .contains('attendees_json', [{ email }])
      .neq('event_id', opts.event.event_id)
      .order('meeting_start_time', { ascending: false })
      .limit(3)
    for (const r of data || []) {
      out.priorMeetings.push({ title: r.meeting_title || '(untitled meeting)', when: r.meeting_start_time || null })
    }
  } catch (e: any) {
    console.warn('[bizdev-briefing] prior-meetings lookup failed:', e?.message || e)
  }

  // 2. Projects / inquiries matching the company (client name), scoped to the
  //    workspace. MULTI-WORKSPACE INVARIANT: only run this when we can scope by
  //    workspace_id — an unscoped client match could pull another workspace's
  //    project into the briefing. Prefix match (not %company%) narrows false
  //    positives ("Oshi" won't match "Foshion") without a new search subsystem.
  if (opts.company && opts.workspaceId) {
    try {
      const { data } = await sb
        .from('projects')
        .select('name, client')
        .eq('workspace_id', opts.workspaceId)
        .ilike('client', `${opts.company}%`)
        .limit(3)
      for (const p of data || []) out.projects.push({ name: p.name, client: p.client || null })
    } catch (e: any) {
      console.warn('[bizdev-briefing] projects lookup failed:', e?.message || e)
    }
  }

  // 3. Canonical knowledge search (transcripts / notes / docs) — reuse the
  //    shared retrieval layer rather than a bespoke per-subsystem search.
  try {
    const query = [opts.attendee.displayName, opts.company, email, opts.event.summary]
      .filter(Boolean)
      .join(' ')
    const results = await search(query, { workspaceId: opts.workspaceId ?? undefined, limit: 4 })
    for (const r of results.slice(0, 3)) {
      out.knowledge.push({ title: r.title, ref: r.sourceUrl || `doc:${r.documentId}` })
    }
  } catch (e: any) {
    console.warn('[bizdev-briefing] knowledge search failed:', e?.message || e)
  }

  return out
}

/** Public-research portion of the evidence, before merge. */
interface PublicEvidence {
  name: string | null
  company: string | null
  facts: { claim: string; source_ref: string | null }[]
  inferences: { claim: string; basis: string | null }[]
  missing: string[]
  sources: { ref: string; kind: string }[]
  contradiction: boolean
}

/**
 * Research one external attendee into normalized evidence. Internal R&F history
 * is retrieved FIRST and always included; public web research SUPPLEMENTS it
 * (never replaces it). Passes all identity signals (name from title/displayName,
 * email, company from domain) plus known internal context to the model, forces a
 * JSON evidence object, and applies deterministic weighting on top. Non-fatal:
 * on any failure (no API key, model error, non-JSON output) it still returns the
 * internal-history evidence, so prose never leaks and prior history still shows.
 *
 * `deps.getInternalHistory` is injectable for tests.
 */
export async function researchAttendee(
  attendee: { email: string; displayName?: string },
  event: CalendarEvent,
  deps: { getInternalHistory?: (a: { email: string; displayName?: string }) => Promise<InternalHistory> } = {},
): Promise<AttendeeEvidence> {
  const cand = buildAttendeeIdentityCandidates({ event, attendee })
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID || null

  let internal: InternalHistory
  try {
    internal = deps.getInternalHistory
      ? await deps.getInternalHistory(attendee)
      : await retrieveInternalHistory({ event, attendee, company: cand.company, workspaceId })
  } catch {
    internal = { priorMeetings: [], projects: [], knowledge: [] }
  }
  const internalEv = internalHistoryToEvidence(internal)

  // Merge internal (always) + public (supplement) into normalized evidence, and
  // weight the status from the COMBINED corroboration.
  const merge = (pub: PublicEvidence): AttendeeEvidence => {
    const facts = [...internalEv.facts, ...pub.facts]
    const sources = [...internalEv.sources, ...pub.sources]
    const corroboration = sources.length + facts.filter((f) => f.source_ref).length
    const status = resolveIdentityStatus({
      hasName: !!cand.name,
      hasCompany: !!cand.company,
      corroboratingSources: corroboration,
      contradiction: pub.contradiction,
    })
    // Absence of internal history is represented explicitly — not invented.
    const missing = new Set<string>(pub.missing)
    if (!internalEv.found) missing.add('prior R&F history')
    return {
      identity: {
        status,
        name: pub.name || cand.name,
        company: pub.company || cand.company,
        candidates: cand.candidates,
      },
      facts,
      inferences: pub.inferences,
      missing: [...missing],
      sources,
    }
  }

  const emptyPublic: PublicEvidence = {
    name: null,
    company: null,
    facts: [],
    inferences: [],
    missing: internalEv.found ? [] : ['public profile'],
    sources: [],
    contradiction: false,
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return merge(emptyPublic)

  try {
    const client = new Anthropic({ apiKey })
    const internalContext = internalEv.found
      ? `Known internal R&F history (already on file — do NOT repeat, only build on it):\n` +
        internalEv.facts.map((f) => `- ${f.claim}`).join('\n') + '\n\n'
      : 'No prior R&F history is on file for this contact.\n\n'
    const prompt =
      `Meeting title: ${JSON.stringify(event.summary || '')}\n` +
      `Attendee email: ${attendee.email}\n` +
      `Candidate name: ${JSON.stringify(cand.name)}\n` +
      `Candidate company (from email domain): ${JSON.stringify(cand.company)}\n\n` +
      internalContext +
      `Search the web to corroborate or correct these candidates, then return the evidence JSON.`

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      system:
        'You research a business-development meeting attendee for Ranger & Fox, a creative video ' +
        'production studio. You are given candidate identity signals (name from the meeting title, ' +
        'company from the email domain) and any internal history already on file. Treat the ' +
        'candidates as UNVERIFIED: search the web to corroborate or correct them. Distinguish ' +
        'verified facts (with a source) from reasonable inferences. Never ask the user for more ' +
        'context and never emit conversational text.\n\n' +
        'Respond with ONLY this JSON (no prose, no code fence):\n' +
        '{\n' +
        '  "identity": { "status": "resolved|likely|unresolved", "name": string|null, "company": string|null },\n' +
        '  "facts": [{ "claim": string, "source_ref": string|null }],\n' +
        '  "inferences": [{ "claim": string, "basis": string }],\n' +
        '  "missing": [string],\n' +
        '  "sources": [{ "ref": string, "kind": "public|internal" }],\n' +
        '  "contradiction": boolean\n' +
        '}\n' +
        'Set contradiction:true only if public info disputes a candidate. If you find nothing ' +
        'reliable, return status:"unresolved" with empty facts — do NOT guess.',
      messages: [{ role: 'user', content: prompt }],
    })

    const text = res.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
      .trim()

    const parsed = parseAttendeeEvidence(text)
    if (!parsed) return merge(emptyPublic)

    return merge({
      name: parsed.identity.name || null,
      company: parsed.identity.company || null,
      facts: parsed.facts,
      inferences: parsed.inferences,
      missing: parsed.missing,
      sources: parsed.sources,
      contradiction: parsed.contradiction,
    })
  } catch (err: any) {
    console.warn(`[bizdev-briefing] research failed for ${attendee.email}:`, err?.message || err)
    return merge(emptyPublic)
  }
}

export async function composeBizdevBriefing(ctx: { event: CalendarEvent }): Promise<BizdevBriefingArtifact> {
  const { event } = ctx
  const sb = createAdminClient()

  const { data: staffRows } = await sb
    .from('staff')
    .select('id, email, email_aliases, slack_user_id, full_name, is_active')
    .eq('is_active', true)

  // Recipients = the R&F people actually on the invite (same privacy rule as
  // project briefings).
  const recipients = matchAttendeesToStaff(event.attendees || [], staffRows || [])

  // Externals = everyone NOT recognized as internal staff (broader than the
  // recipient set, which additionally requires a Slack id).
  const internalEmails = buildStaffEmailSet(staffRows || [])
  const externals = filterExternalAttendees(event.attendees || [], internalEmails)

  const evidence = await Promise.all(externals.map((a) => researchAttendee(a, event)))

  const channelText = buildBizdevBriefingText({ event, externals, evidence })

  return { channelText, recipients }
}
