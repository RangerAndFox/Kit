// @ts-nocheck
/**
 * Bizdev briefing — identity resolution + evidence-contract tests.
 *
 * Run: npx tsx --test src/lib/agent/bizdev-briefing.test.ts
 *
 * These lock the two research defects from the Oshi incident:
 *   A. identity resolution now uses the meeting title + email domain, not just
 *      the bare email;
 *   B. a conversational model reply can never reach the briefing — it fails to
 *      parse as evidence and degrades to `unresolved` (no verbatim prose).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCompanyFromDomain,
  nameFromTitle,
  buildAttendeeIdentityCandidates,
  resolveIdentityStatus,
  parseAttendeeEvidence,
  renderAttendeeEvidence,
  buildBizdevBriefingText,
  filterExternalAttendees,
  buildStaffEmailSet,
  internalHistoryToEvidence,
  researchAttendee,
  retrieveInternalHistory,
} from './bizdev-briefing'
import { matchAttendeesToStaff } from './briefing-composer'

const OSHI_EVENT = {
  event_id: 'evt-oshi',
  calendar_id: 'cal',
  summary: 'R&F + Ryan Dolinsky (Oshi)',
  start_time: '2026-07-15T16:00:00Z',
  end_time: '2026-07-15T17:00:00Z',
  attendees: [{ email: 'ryan@oshi.co' }],
}
const CLARIFICATION =
  "I'd be happy to help you research this meeting attendee, but I need a name or more context"

describe('company-from-domain (candidate generation)', () => {
  it('derives a company from a corporate domain', () => {
    assert.equal(parseCompanyFromDomain('ryan@oshi.co'), 'Oshi')
    assert.equal(parseCompanyFromDomain('x@acme.co.uk'), 'Acme')
  })
  it('returns null for generic consumer providers', () => {
    assert.equal(parseCompanyFromDomain('x@gmail.com'), null)
    assert.equal(parseCompanyFromDomain('x@outlook.com'), null)
    assert.equal(parseCompanyFromDomain('not-an-email'), null)
  })
})

describe('name-from-title (candidate generation)', () => {
  it('extracts the attendee name anchored on the email local part', () => {
    assert.equal(nameFromTitle('R&F + Ryan Dolinsky (Oshi)', 'ryan@oshi.co'), 'Ryan Dolinsky')
  })
  it('returns null when the title has no matching name', () => {
    assert.equal(nameFromTitle('Weekly sync', 'ryan@oshi.co'), null)
    assert.equal(nameFromTitle('', 'ryan@oshi.co'), null)
  })
})

describe('buildAttendeeIdentityCandidates', () => {
  it('assembles name + company for the Oshi case even with no displayName', () => {
    const c = buildAttendeeIdentityCandidates({ event: OSHI_EVENT, attendee: { email: 'ryan@oshi.co' } })
    assert.equal(c.name, 'Ryan Dolinsky')
    assert.equal(c.company, 'Oshi')
    assert.ok(c.candidates.some((x) => x.from === 'meeting-title'))
    assert.ok(c.candidates.some((x) => x.from === 'email-domain'))
  })
  it('prefers an explicit calendar displayName as the name', () => {
    const c = buildAttendeeIdentityCandidates({
      event: OSHI_EVENT,
      attendee: { email: 'ryan@oshi.co', displayName: 'Ryan D.' },
    })
    assert.equal(c.name, 'Ryan D.')
  })
})

describe('resolveIdentityStatus (weighting, not a hard two-signal rule)', () => {
  it('title-name + company-domain establishes likely', () => {
    assert.equal(
      resolveIdentityStatus({ hasName: true, hasCompany: true, corroboratingSources: 0, contradiction: false }),
      'likely',
    )
  })
  it('corroborating evidence promotes to resolved', () => {
    assert.equal(
      resolveIdentityStatus({ hasName: true, hasCompany: true, corroboratingSources: 2, contradiction: false }),
      'resolved',
    )
  })
  it('a contradiction lowers confidence below resolved', () => {
    assert.equal(
      resolveIdentityStatus({ hasName: true, hasCompany: true, corroboratingSources: 3, contradiction: true }),
      'likely',
    )
  })
  it('a bare email with no candidates is unresolved', () => {
    assert.equal(
      resolveIdentityStatus({ hasName: false, hasCompany: false, corroboratingSources: 0, contradiction: false }),
      'unresolved',
    )
  })
})

describe('parseAttendeeEvidence (structural guard against prose leakage)', () => {
  it('parses a valid evidence JSON object', () => {
    const raw = JSON.stringify({
      identity: { status: 'resolved', name: 'Ryan Dolinsky', company: 'Oshi' },
      facts: [{ claim: 'Founder of Oshi', source_ref: 'https://oshi.co/about' }],
      inferences: [{ claim: 'Likely decision-maker', basis: 'founder title' }],
      missing: [],
      sources: [{ ref: 'https://oshi.co', kind: 'public' }],
      contradiction: false,
    })
    const ev = parseAttendeeEvidence(raw)
    assert.ok(ev)
    assert.equal(ev.facts.length, 1)
    assert.equal(ev.contradiction, false)
  })

  it('REJECTS a conversational clarification reply (returns null → no prose leaks)', () => {
    assert.equal(parseAttendeeEvidence(CLARIFICATION), null)
    assert.equal(parseAttendeeEvidence(''), null)
    assert.equal(parseAttendeeEvidence('Sure! Here is what I found: ...'), null)
  })
})

describe('renderAttendeeEvidence / buildBizdevBriefingText (no raw prose)', () => {
  it('renders an unresolved attendee with a fixed fallback, never prose', () => {
    const ev = {
      identity: { status: 'unresolved', name: null, company: null, candidates: [] },
      facts: [], inferences: [], missing: ['public profile'], sources: [],
    }
    const text = buildBizdevBriefingText({
      event: OSHI_EVENT,
      externals: [{ email: 'ryan@oshi.co' }],
      evidence: [ev as any],
    })
    assert.match(text, /No reliable public information found/)
    assert.doesNotMatch(text, /I'd be happy to help/)
  })

  it('a null evidence slot degrades to a fixed fallback', () => {
    const text = buildBizdevBriefingText({
      event: OSHI_EVENT,
      externals: [{ email: 'ryan@oshi.co' }],
      evidence: [null],
    })
    assert.match(text, /No reliable info found/)
  })

  it('renders resolved facts as structured bullets', () => {
    const ev = {
      identity: { status: 'resolved', name: 'Ryan Dolinsky', company: 'Oshi', candidates: [] },
      facts: [{ claim: 'Founder of Oshi', source_ref: 'https://oshi.co' }],
      inferences: [], missing: [], sources: [],
    }
    const lines = renderAttendeeEvidence(ev as any, { email: 'ryan@oshi.co' })
    assert.ok(lines.some((l) => l.includes('Ryan Dolinsky')))
    assert.ok(lines.some((l) => l.includes('Founder of Oshi')))
    assert.ok(lines.some((l) => l.includes('Confidence: resolved')))
  })
})

describe('internal history (authoritative R&F records)', () => {
  it('normalizes history into internal-tagged evidence and invents nothing on empty', () => {
    const ev = internalHistoryToEvidence({
      priorMeetings: [{ title: 'Oshi kickoff', when: '2026-01-10' }],
      projects: [{ name: 'Oshi sizzle', client: 'Oshi' }],
      knowledge: [],
    })
    assert.equal(ev.found, true)
    assert.ok(ev.facts.every((f) => (f.source_ref || '').startsWith('internal:')))
    assert.ok(ev.sources.every((s) => s.kind === 'internal'))

    const empty = internalHistoryToEvidence({ priorMeetings: [], projects: [], knowledge: [] })
    assert.equal(empty.found, false)
    assert.equal(empty.facts.length, 0)
    assert.equal(empty.sources.length, 0)
  })

  it('OSHI PATH: existing internal history appears as evidence (public research supplements it)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY // force internal-only path (no public call)
    try {
      const history = {
        priorMeetings: [{ title: 'Oshi kickoff', when: '2026-01-10' }],
        projects: [{ name: 'Oshi sizzle', client: 'Oshi' }],
        knowledge: [],
      }
      const ev = await researchAttendee({ email: 'ryan@oshi.co' }, OSHI_EVENT, {
        getInternalHistory: async () => history,
      })
      assert.ok(ev.facts.some((f) => f.claim.includes('Oshi kickoff')))
      assert.ok(ev.facts.some((f) => f.claim.includes('Oshi sizzle')))
      assert.ok(ev.sources.some((s) => s.kind === 'internal'))
      // internal corroboration + title-name + company-domain → resolved
      assert.equal(ev.identity.status, 'resolved')
      assert.ok(!ev.missing.includes('prior R&F history'))
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it('OSHI PATH: absence of history is represented without invention', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const ev = await researchAttendee({ email: 'ryan@oshi.co' }, OSHI_EVENT, {
        getInternalHistory: async () => ({ priorMeetings: [], projects: [], knowledge: [] }),
      })
      assert.equal(ev.facts.length, 0, 'no invented facts when there is no history')
      assert.ok(ev.missing.includes('prior R&F history'))
      // candidates still present (title-name + company) but nothing corroborates → likely
      assert.equal(ev.identity.status, 'likely')
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

describe('retrieveInternalHistory workspace scoping', () => {
  // Minimal chainable fake supabase client that records .eq() calls and applies
  // the workspace filter to the returned rows.
  function fakeSb(rowsByTable: Record<string, any[]>, capture: { eqs: [string, string, any][] }) {
    const make = (table: string) => {
      const state: Record<string, any> = {}
      const q: any = {
        select: () => q,
        contains: () => q,
        neq: () => q,
        order: () => q,
        ilike: () => q,
        eq: (col: string, val: any) => {
          state[col] = val
          capture.eqs.push([table, col, val])
          return q
        },
        limit: (n: number) => {
          let rows = rowsByTable[table] || []
          if (state.workspace_id !== undefined) rows = rows.filter((r) => r.workspace_id === state.workspace_id)
          return Promise.resolve({ data: rows.slice(0, n), error: null })
        },
      }
      return q
    }
    return { from: (table: string) => make(table) }
  }

  it('applies the workspace filter and excludes another workspace’s project', async () => {
    const capture = { eqs: [] as [string, string, any][] }
    const sb = fakeSb(
      {
        meeting_briefings: [],
        projects: [
          { name: 'Oshi sizzle', client: 'Oshi', workspace_id: 'ws-1' },
          { name: 'Foreign Oshi', client: 'Oshi', workspace_id: 'ws-2' },
        ],
      },
      capture,
    )
    const hist = await retrieveInternalHistory({
      event: OSHI_EVENT as any,
      attendee: { email: 'ryan@oshi.co' },
      company: 'Oshi',
      workspaceId: 'ws-1',
      sb,
      search: async () => [],
    })
    // Only the ws-1 project is present; the ws-2 project is excluded.
    assert.equal(hist.projects.length, 1)
    assert.equal(hist.projects[0].name, 'Oshi sizzle')
    // The workspace filter was actually applied to the projects query.
    assert.ok(capture.eqs.some(([t, c, v]) => t === 'projects' && c === 'workspace_id' && v === 'ws-1'))
  })

  it('skips the projects lookup entirely when no workspaceId is available (no unscoped leak)', async () => {
    const capture = { eqs: [] as [string, string, any][] }
    const sb = fakeSb(
      { meeting_briefings: [], projects: [{ name: 'X', client: 'Oshi', workspace_id: 'ws-2' }] },
      capture,
    )
    const hist = await retrieveInternalHistory({
      event: OSHI_EVENT as any,
      attendee: { email: 'ryan@oshi.co' },
      company: 'Oshi',
      workspaceId: null,
      sb,
      search: async () => [],
    })
    assert.equal(hist.projects.length, 0)
    assert.ok(!capture.eqs.some(([t]) => t === 'projects'))
  })
})

describe('matchAttendeesToStaff (recipient boundary preserved + staff.id)', () => {
  const staff = [
    { id: 's1', email: 'ann@rf.tv', slack_user_id: 'U1', full_name: 'Ann', is_active: true },
    { id: 's2', email: 'bob@rf.tv', slack_user_id: 'U2', full_name: 'Bob', is_active: false },
    { id: 's3', email: 'cid@rf.tv', slack_user_id: null, full_name: 'Cid', is_active: true },
  ]

  it('EXTERNAL-RECIPIENT EXCLUSION: external attendees never become recipients', () => {
    const recips = matchAttendeesToStaff(
      [{ email: 'ryan@oshi.co' }, { email: 'ann@rf.tv' }],
      staff,
    )
    assert.equal(recips.length, 1)
    assert.equal(recips[0].email, 'ann@rf.tv')
    assert.equal(recips[0].staff_id, 's1')
  })

  it('excludes inactive staff and staff without a Slack id', () => {
    const recips = matchAttendeesToStaff(
      [{ email: 'bob@rf.tv' }, { email: 'cid@rf.tv' }],
      staff,
    )
    assert.equal(recips.length, 0)
  })

  it('filterExternalAttendees uses the full staff email set', () => {
    const internal = buildStaffEmailSet([{ email: 'ann@rf.tv' }])
    const ext = filterExternalAttendees([{ email: 'ann@rf.tv' }, { email: 'ryan@oshi.co' }], internal)
    assert.equal(ext.length, 1)
    assert.equal(ext[0].email, 'ryan@oshi.co')
  })
})
