/**
 * Parity guard for the shared identity derivations. Each oracle below re-encodes
 * the ORIGINAL inline expression from its create-side call site verbatim; the
 * test asserts the extracted helper produces byte-identical output across a
 * matrix of inputs (spaces, punctuation, unicode, hyphenated clients, empties).
 *
 * If a helper is ever "cleaned up", these oracles must be updated in lockstep —
 * they are the definition of correct, not the implementation.
 *
 * Run: npx tsx --test src/lib/provisioner/identifiers.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveProjectCode,
  deriveDropboxSafeName,
  deriveFrameioBusinessLabel,
  deriveSlackShortId,
  deriveSlackSlug,
  deriveProjectIdentifiers,
} from './identifiers'

// ─── Oracles: the original inline logic, copied verbatim ─────────────────────

// interactions.ts: `${form.projectNumber}-${form.clientName.replace(/\s+/g, '')}`
function oracleProjectCode(projectNumber: string, clientName: string): string {
  return `${projectNumber}-${clientName.replace(/\s+/g, '')}`
}

// interactions.ts / dropbox.ts safeName
function oracleDropboxSafeName(n: string, c: string, p: string): string {
  return [n, c, p]
    .map((x) => (x ? String(x).trim() : ''))
    .filter(Boolean)
    .join('_')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
}

// frameio.ts businessLabel — trims each field before joining (mirrors safeName's
// trim), so a stray leading/trailing space never survives into the Frame.io name.
function oracleFrameioLabel(n: string, c: string, p: string): string {
  return [n, c, p].map((x) => (x ? String(x).trim() : '')).filter(Boolean).join('_')
}

// slack.ts shortId + base + slug
function oracleSlack(projectId: string, n: string, c: string, p: string) {
  const shortId = String(projectId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
  const base = [n, c, p]
    .filter((part) => part && String(part).trim())
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80 - (shortId.length + 1))
  const slug = shortId ? `${base}-${shortId}` : base
  return { shortId, base, slug }
}

// ─── Input matrix ────────────────────────────────────────────────────────────

const CASES: Array<{ projectId: string; projectNumber: string; client: string; projectName: string }> = [
  { projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', projectNumber: '2601', client: 'Nike', projectName: 'Summer Campaign' },
  { projectId: 'ZZZ-000', projectNumber: '2655', client: 'Microsoft', projectName: 'Q3 Launch' },
  { projectId: '00000000-0000-0000-0000-000000000000', projectNumber: '42', client: 'Coca-Cola', projectName: 'Holiday: 2026!' },
  { projectId: 'x', projectNumber: '7', client: 'A B  C', projectName: 'name/with\\slashes' },
  { projectId: '', projectNumber: '', client: 'OnlyClient', projectName: '' },
  { projectId: 'deadbeefcafebabe1234', projectNumber: '9001', client: 'Über Straße', projectName: 'Ünïcödé Tëst' },
  { projectId: '----', projectNumber: '  ', client: '   ', projectName: '   ' },
  { projectId: 'abcdefgh', projectNumber: '123', client: 'Client-With-Hyphens', projectName: 'Very Long Project Name That Should Push The Slug Past The Eighty Character Cap For Slack Channels' },
]

describe('deriveProjectCode parity', () => {
  for (const t of CASES) {
    it(`code(${t.projectNumber}, ${t.client})`, () => {
      assert.equal(deriveProjectCode(t.projectNumber, t.client), oracleProjectCode(t.projectNumber, t.client))
    })
  }
})

describe('deriveDropboxSafeName parity', () => {
  for (const t of CASES) {
    it(`safeName(${t.projectNumber}, ${t.client}, ${t.projectName})`, () => {
      assert.equal(
        deriveDropboxSafeName(t.projectNumber, t.client, t.projectName),
        oracleDropboxSafeName(t.projectNumber, t.client, t.projectName),
      )
    })
  }
})

describe('deriveFrameioBusinessLabel parity', () => {
  for (const t of CASES) {
    it(`label(${t.projectNumber}, ${t.client}, ${t.projectName})`, () => {
      assert.equal(
        deriveFrameioBusinessLabel(t.projectNumber, t.client, t.projectName),
        oracleFrameioLabel(t.projectNumber, t.client, t.projectName),
      )
    })
  }

  it('trims leading/trailing whitespace like the Dropbox safe-name (no stray spaces in Frame.io)', () => {
    // plain_text_input never trims, so a trailing space can reach here; it must not
    // survive into the live Frame.io rename (the trimmed preview would disagree).
    assert.equal(deriveFrameioBusinessLabel('2601', ' Nike ', 'Winter Campaign '), '2601_Nike_Winter Campaign')
  })
})

describe('deriveSlackSlug parity', () => {
  for (const t of CASES) {
    it(`slug(${t.projectId}, ${t.projectNumber}, ${t.client})`, () => {
      const oracle = oracleSlack(t.projectId, t.projectNumber, t.client, t.projectName)
      assert.equal(deriveSlackShortId(t.projectId), oracle.shortId)
      const got = deriveSlackSlug(t)
      assert.equal(got.slackShortId, oracle.shortId)
      assert.equal(got.slackSlugBase, oracle.base)
      assert.equal(got.slackSlug, oracle.slug)
    })
  }
})

describe('deriveProjectIdentifiers aggregates all fields', () => {
  for (const t of CASES) {
    it(`identifiers(${t.projectNumber}, ${t.client}, ${t.projectName})`, () => {
      const ids = deriveProjectIdentifiers(t)
      const oracle = oracleSlack(t.projectId, t.projectNumber, t.client, t.projectName)
      assert.equal(ids.projectCode, oracleProjectCode(t.projectNumber, t.client))
      assert.equal(ids.dropboxSafeName, oracleDropboxSafeName(t.projectNumber, t.client, t.projectName))
      assert.equal(ids.frameioBusinessLabel, oracleFrameioLabel(t.projectNumber, t.client, t.projectName))
      assert.equal(ids.slackShortId, oracle.shortId)
      assert.equal(ids.slackSlugBase, oracle.base)
      assert.equal(ids.slackSlug, oracle.slug)
    })
  }
})

describe('slug length cap accounts for the short-id suffix', () => {
  it('full slug never exceeds 80 chars', () => {
    for (const t of CASES) {
      const { slackSlug } = deriveSlackSlug(t)
      assert.ok(slackSlug.length <= 80, `slug too long: ${slackSlug.length}`)
    }
  })
})
