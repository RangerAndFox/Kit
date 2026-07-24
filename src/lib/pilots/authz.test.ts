/**
 * Centralized-authorization tests: a foreign workspace cannot create, mutate,
 * render, or finalize another workspace's pilot. The authoritative workspace is
 * always derived from the project/pilot record, never the caller's input.
 *
 * Run: npx tsx --test src/lib/pilots/authz.test.ts
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
  refreshPilotCanvas,
  setVisualLanguage,
  type ActorContext,
  type PilotDeps,
} from './service'

const OWNER: ActorContext = { actingUserId: 'U_OWNER', workspaceId: 'ws-owner' }
const FOREIGN: ActorContext = { actingUserId: 'U_ATTACKER', workspaceId: 'ws-attacker' }

function setup() {
  const store = makeFakePilotStore()
  store.projectWorkspaces['proj'] = 'ws-owner'
  const deps: PilotDeps = { store, canvas: makeFakeCanvas(), now: () => 't' }
  return { store, deps }
}

function isUnauthorized(r: { ok: boolean; reason?: string }): boolean {
  return r.ok === false && !!r.reason && r.reason.startsWith('unauthorized:')
}

describe('cross-workspace access is rejected for every operation', () => {
  it('create: a foreign workspace cannot create a pilot on another workspace project', async () => {
    const { store, deps } = setup()
    const res = await createVisualDevPilot(deps, { projectId: 'proj', title: 'X', actor: FOREIGN })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.reason, 'unauthorized:wrong_workspace')
    assert.equal(store.pilots.length, 0)
  })

  it('mutate / render / finalize: a foreign workspace is rejected and nothing changes', async () => {
    const { store, deps } = setup()
    // Owner creates the pilot + one generation to target.
    const created = await createVisualDevPilot(deps, { projectId: 'proj', title: 'X', actor: OWNER })
    assert.ok(created.ok)
    const pilotId = (created as { ok: true; value: { id: string } }).value.id
    const genRes = await recordGeneration(deps, { pilotId, externalRef: 'g', actor: OWNER })
    assert.ok(genRes.ok)
    const generationId = (genRes as { ok: true; value: { id: string } }).value.id

    const evidenceBefore = store.evidence.length
    const refsBefore = store.references.length
    const mapsBefore = store.materialMaps.length
    const valsBefore = store.validations.length

    assert.ok(isUnauthorized(await setVisualLanguage(deps, { pilotId, text: 'x', actor: FOREIGN })))
    assert.ok(isUnauthorized(await addReference(deps, { pilotId, refType: 'styleframe_direction', label: 'a', actor: FOREIGN })))
    assert.ok(isUnauthorized(await recordEvidence(deps, { pilotId, category: 'judgment', valueText: 'x', actor: FOREIGN })))
    assert.ok(isUnauthorized(await recordGeneration(deps, { pilotId, externalRef: 'y', actor: FOREIGN })))
    assert.ok(isUnauthorized(await recordMaterialMap(deps, { pilotId, packageName: 'p', mapType: 'albedo', purpose: 'x', actor: FOREIGN })))
    assert.ok(isUnauthorized(await recordValidation(deps, { pilotId, tool: 'redshift', evidenceRef: 'r', passed: true, actor: FOREIGN })))
    assert.ok(isUnauthorized(await decideGenerationAcceptance(deps, { generationId, accept: true, actor: FOREIGN })))
    assert.ok(isUnauthorized(await refreshPilotCanvas(deps, { pilotId, channelId: 'C', actor: FOREIGN })))
    assert.ok(isUnauthorized(await finalizeRecommendation(deps, { pilotId, recommendation: 'adopt', rationale: null, actor: FOREIGN })))

    // No side effects from any rejected call.
    assert.equal(store.pilots[0].visual_language, null)
    assert.equal(store.references.length, refsBefore)
    assert.equal(store.evidence.length, evidenceBefore)
    assert.equal(store.materialMaps.length, mapsBefore)
    assert.equal(store.validations.length, valsBefore)
    // The generation stayed pending (foreign acceptance rejected).
    assert.equal(store.generations.find((g) => g.id === generationId)!.acceptance, 'pending')
    assert.equal(store.pilots[0].status, 'active')
    assert.equal(store.pilots[0].canvas_id, null)
  })

  it('a missing/unknown pilot is unauthorized (not_found), never a silent pass', async () => {
    const { deps } = setup()
    const res = await setVisualLanguage(deps, { pilotId: 'nope', text: 'x', actor: OWNER })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.reason, 'unauthorized:not_found')
  })
})
