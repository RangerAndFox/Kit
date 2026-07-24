/**
 * One complete controlled pilot path, end to end, with in-memory fakes.
 * Mirrors the mission's 14-step controlled-workflow validation.
 *
 * Run: npx tsx --test src/lib/pilots/workflow.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePilotStore, makeFakeCanvas } from './fake-store'
import { computePilotMetrics } from './metrics'
import { REQUIRED_MEASUREMENT_KEYS } from './types'
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
  type PilotDeps,
} from './service'

const ARTIST = 'U_ARTIST'
const WS = 'ws-1'
const CH = 'C_PILOT'

function unwrap<T>(r: { ok: boolean; value?: T; reason?: string }): T {
  assert.ok(r.ok, `expected ok, got ${r.reason}`)
  return (r as { value: T }).value
}

describe('controlled visual-development pilot path', () => {
  it('runs create → evidence → gate → finalize → traceable projection', async () => {
    const store = makeFakePilotStore()
    const canvas = makeFakeCanvas()
    const deps: PilotDeps = { store, canvas, now: () => '2026-03-03T12:00:00.000Z' }
    const actor = { actingUserId: ARTIST, workspaceId: WS }
    // The project exists in the artist's workspace (authoritative source).
    store.projectWorkspaces['proj-existing'] = WS

    // 1. Attach pilot to an existing project.
    const pilotId = unwrap(
      await createVisualDevPilot(deps, { projectId: 'proj-existing', title: 'Ignite25', actor }),
    ).id

    // 2. Pinterest + the one designated Figma moodboard.
    unwrap(await addReference(deps, { pilotId, refType: 'pinterest', url: 'https://pin/1', label: 'grit', actor }))
    unwrap(await addReference(deps, { pilotId, refType: 'figma_moodboard', url: 'https://figma/mb', label: 'moodboard', actor }))

    // 3. Visual language + deliberately distinct styleframe directions.
    unwrap(await setVisualLanguage(deps, { pilotId, text: 'Tactile neon, high-contrast, hand-made imperfection.', actor }))
    unwrap(await addReference(deps, { pilotId, refType: 'styleframe_direction', label: 'Direction A — clean', actor }))
    unwrap(await addReference(deps, { pilotId, refType: 'styleframe_direction', label: 'Direction B — gritty', actor }))

    // 4. Generation outputs.
    const g1 = unwrap(await recordGeneration(deps, { pilotId, source: 'higgsfield', externalRef: 'up://1', label: 'frame1', actor }))
    const g2 = unwrap(await recordGeneration(deps, { pilotId, source: 'higgsfield', externalRef: 'up://2', label: 'frame2', actor }))
    const g3 = unwrap(await recordGeneration(deps, { pilotId, source: 'higgsfield', externalRef: 'up://3', label: 'frame3', actor }))

    // 5. Human accepts and rejects (explicit + attributed).
    unwrap(await decideGenerationAcceptance(deps, { generationId: g1.id, accept: true, actor }))
    unwrap(await decideGenerationAcceptance(deps, { generationId: g2.id, accept: true, actor }))
    unwrap(await decideGenerationAcceptance(deps, { generationId: g3.id, accept: false, actor }))

    // 6. Material package + technically justified maps (each with a purpose).
    unwrap(await recordMaterialMap(deps, { pilotId, packageName: 'BrushedSteel', mapType: 'albedo', purpose: 'base color response', actor }))
    unwrap(await recordMaterialMap(deps, { pilotId, packageName: 'BrushedSteel', mapType: 'roughness', purpose: 'micro-surface specular breakup', actor }))
    unwrap(await recordMaterialMap(deps, { pilotId, packageName: 'BrushedSteel', mapType: 'normal', purpose: 'fine tooling detail without geometry', actor }))
    unwrap(await recordMaterialMap(deps, { pilotId, packageName: 'BrushedSteel', mapType: 'height', purpose: 'parallax + displacement for deep grooves', actor }))

    // 7. Cinema 4D / Redshift validation (recorded evidence required).
    unwrap(await recordValidation(deps, { pilotId, tool: 'cinema4d', evidenceRef: 'c4d_scene.png', passed: true, subject: 'BrushedSteel', actor }))
    unwrap(await recordValidation(deps, { pilotId, tool: 'redshift', evidenceRef: 'rs_render.exr', passed: true, subject: 'BrushedSteel', actor }))

    // 8. Objective measurements and subjective evaluations, recorded SEPARATELY.
    for (const key of REQUIRED_MEASUREMENT_KEYS) {
      unwrap(await recordEvidence(deps, { pilotId, category: 'measurement', metricKey: key, label: key, valueNumeric: 1, unit: 'x', actor }))
    }
    unwrap(await recordEvidence(deps, { pilotId, category: 'observation', valueText: 'Continuity held across 3 frames.', actor }))
    unwrap(await recordEvidence(deps, { pilotId, category: 'judgment', valueText: 'Reads as original, would reuse.', actor }))

    // 9. Deterministic metrics.
    const snap1 = await store.loadSnapshot(pilotId)
    assert.ok(snap1)
    const metrics = computePilotMetrics(snap1!.generations)
    assert.equal(metrics.totalGenerations, 3)
    assert.equal(metrics.usableGenerations, 2)
    assert.equal(metrics.usableOutputRate, 2 / 3)

    // 10. Render the dedicated Canvas (created once).
    unwrap(await refreshPilotCanvas(deps, { pilotId, channelId: CH, actor }))
    assert.equal(canvas.created, 1)
    assert.equal(canvas.edited, 0)

    // 11. Incomplete evidence blocks finalization (assumptions/unknowns/decision
    //     support not yet recorded).
    const blocked = await finalizeRecommendation(deps, { pilotId, recommendation: 'adopt', rationale: 'x', actor })
    assert.equal(blocked.ok, false)
    const missingKeys = blocked.finalize && !blocked.finalize.ok && blocked.finalize.completeness
      ? blocked.finalize.completeness.missing.map((m) => m.key)
      : []
    assert.ok(missingKeys.includes('assumptions_recorded'))
    assert.ok(missingKeys.includes('unknowns_recorded'))
    assert.ok(missingKeys.includes('recommendation_support'))
    assert.equal(store.pilots[0].status, 'active') // not finalized

    // 12. Add the missing evidence (explicit "none identified" is a valid record).
    unwrap(await recordEvidence(deps, { pilotId, category: 'assumption', valueText: 'none identified', actor }))
    unwrap(await recordEvidence(deps, { pilotId, category: 'unknown', valueText: 'long-run editability at scale', actor }))
    unwrap(await recordEvidence(deps, { pilotId, category: 'decision', label: 'support', valueText: 'Cost -45%, usable rate 67%, artist willing to reuse.', actor }))

    // 13. Finalize a HUMAN-authored recommendation.
    const finalized = unwrap(
      await finalizeRecommendation(deps, { pilotId, recommendation: 'adopt', rationale: 'Trustworthy evidence supports adoption.', actor }),
    )
    assert.equal(finalized.status, 'finalized')
    assert.equal(finalized.recommendation, 'adopt')
    assert.equal(finalized.recommendation_by, ARTIST)

    // 14. The rendered recommendation is traceable to its supporting evidence.
    unwrap(await refreshPilotCanvas(deps, { pilotId, channelId: CH, actor }))
    assert.equal(canvas.created, 1) // not recreated — same canvas identity
    assert.ok(canvas.edited >= 1)
    const md = canvas.lastMarkdown ?? ''
    assert.ok(md.includes('Recommendation:** ADOPT'))
    assert.ok(md.includes(ARTIST))
    assert.ok(md.includes('Cost -45%, usable rate 67%'))
    assert.ok(md.includes('Usable-output rate:** 66.7%'))
  })
})
