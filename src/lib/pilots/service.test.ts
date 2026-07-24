/**
 * Service guard tests: centralized authorization, attribution, acceptance-not-by-
 * default, uniqueness pre-check, measurement/purpose/evidence guards, and
 * completeness-gated finalize.
 *
 * Run: npx tsx --test src/lib/pilots/service.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePilotStore, makeFakeCanvas } from './fake-store'
import {
  addReference,
  createVisualDevPilot,
  decideGenerationAcceptance,
  finalizeRecommendation,
  recordEvidence,
  recordGeneration,
  recordMaterialMap,
  recordValidation,
  type ActorContext,
  type PilotDeps,
} from './service'

const ACTOR: ActorContext = { actingUserId: 'U1', workspaceId: 'ws' }

function deps(): PilotDeps & { store: ReturnType<typeof makeFakePilotStore> } {
  const store = makeFakePilotStore()
  store.projectWorkspaces['proj'] = 'ws'
  store.projectWorkspaces['proj2'] = 'ws'
  return { store, canvas: makeFakeCanvas(), now: () => '2026-02-02T00:00:00.000Z' }
}

async function newPilot(d: PilotDeps, projectId = 'proj') {
  const res = await createVisualDevPilot(d, { projectId, title: 'T', actor: ACTOR })
  assert.ok(res.ok, `create failed: ${res.ok ? '' : res.reason}`)
  return (res as { ok: true; value: { id: string } }).value.id
}

describe('createVisualDevPilot', () => {
  it('derives the pilot workspace from the project record (not caller input)', async () => {
    const d = deps()
    const id = await newPilot(d)
    assert.equal(d.store.pilots[0].workspace_id, 'ws')
    assert.equal(d.store.pilots[0].created_by, 'U1')
    assert.ok(id)
  })

  it('rejects create for an unknown project', async () => {
    const d = deps()
    const res = await createVisualDevPilot(d, { projectId: 'ghost', title: 'T', actor: ACTOR })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.reason, 'project_not_found')
  })

  it('enforces at most one active pilot per project (pre-check)', async () => {
    const d = deps()
    await newPilot(d)
    const second = await createVisualDevPilot(d, { projectId: 'proj', title: 'T2', actor: ACTOR })
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'active_pilot_exists')
  })

  it('allows a new pilot for a different project', async () => {
    const d = deps()
    await newPilot(d)
    const other = await createVisualDevPilot(d, { projectId: 'proj2', title: 'T', actor: ACTOR })
    assert.equal(other.ok, true)
  })
})

describe('addReference', () => {
  it('requires a non-empty url for pinterest and figma moodboard', async () => {
    const d = deps()
    const p = await newPilot(d)
    assert.equal((await addReference(d, { pilotId: p, refType: 'pinterest', url: '   ', actor: ACTOR })).ok, false)
    assert.equal((await addReference(d, { pilotId: p, refType: 'figma_moodboard', actor: ACTOR })).ok, false)
    assert.equal((await addReference(d, { pilotId: p, refType: 'styleframe_direction', label: 'A', actor: ACTOR })).ok, true)
    // Author is the authenticated actor.
    assert.equal(d.store.references[0].author, 'U1')
  })
})

describe('recordEvidence', () => {
  it('requires metric_key + value for measurements and forbids metric_key elsewhere', async () => {
    const d = deps()
    const p = await newPilot(d)
    assert.equal((await recordEvidence(d, { pilotId: p, category: 'measurement', valueNumeric: 1, actor: ACTOR })).ok, false)
    assert.equal((await recordEvidence(d, { pilotId: p, category: 'measurement', metricKey: 'time', actor: ACTOR })).ok, false)
    assert.equal((await recordEvidence(d, { pilotId: p, category: 'measurement', metricKey: 'time', valueNumeric: 3, unit: 'h', actor: ACTOR })).ok, true)
    // metric_key on a non-measurement row is rejected.
    assert.equal((await recordEvidence(d, { pilotId: p, category: 'judgment', metricKey: 'time', valueText: 'x', actor: ACTOR })).ok, false)
  })

  it('accepts free-form subjective categories as append rows', async () => {
    const d = deps()
    const p = await newPilot(d)
    assert.equal((await recordEvidence(d, { pilotId: p, category: 'judgment', valueText: 'feels original', actor: ACTOR })).ok, true)
    assert.equal(d.store.evidence.length, 1)
  })
})

describe('decideGenerationAcceptance', () => {
  it('nothing is accepted by default; acceptance is attributed to the human', async () => {
    const d = deps()
    const p = await newPilot(d)
    const g = await recordGeneration(d, { pilotId: p, externalRef: 'x', actor: ACTOR })
    assert.ok(g.ok)
    const gen = (g as { ok: true; value: { id: string; acceptance: string } }).value
    assert.equal(gen.acceptance, 'pending')
    const res = await decideGenerationAcceptance(d, { generationId: gen.id, accept: true, actor: { actingUserId: 'U9', workspaceId: 'ws' } })
    assert.equal(res.ok, true)
    const stored = d.store.generations.find((x) => x.id === gen.id)!
    assert.equal(stored.acceptance, 'accepted')
    assert.equal(stored.accepted_by, 'U9')
    assert.equal(stored.accepted_at, '2026-02-02T00:00:00.000Z')
  })
})

describe('recordMaterialMap / recordValidation', () => {
  it('material map requires a non-empty purpose', async () => {
    const d = deps()
    const p = await newPilot(d)
    assert.equal((await recordMaterialMap(d, { pilotId: p, packageName: 'pkg', mapType: 'albedo', purpose: '  ', actor: ACTOR })).ok, false)
    assert.equal((await recordMaterialMap(d, { pilotId: p, packageName: 'pkg', mapType: 'albedo', purpose: 'base color', actor: ACTOR })).ok, true)
  })

  it('validation requires a recorded evidence reference', async () => {
    const d = deps()
    const p = await newPilot(d)
    assert.equal((await recordValidation(d, { pilotId: p, tool: 'redshift', evidenceRef: '', passed: true, actor: ACTOR })).ok, false)
    assert.equal((await recordValidation(d, { pilotId: p, tool: 'redshift', evidenceRef: 'render.png', passed: true, actor: ACTOR })).ok, true)
  })
})

describe('finalizeRecommendation', () => {
  it('is blocked while evidence is incomplete and leaves the pilot active', async () => {
    const d = deps()
    const p = await newPilot(d)
    const res = await finalizeRecommendation(d, { pilotId: p, recommendation: 'adopt', rationale: null, actor: ACTOR })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.reason, 'finalize_blocked')
    assert.equal(d.store.pilots[0].status, 'active')
  })
})
