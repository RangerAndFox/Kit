/**
 * Pilots — local, non-production smoke harness (Workstream 7).
 *
 * Exercises the SAME production command path (parser → runPilotCommand →
 * service → completeness → Canvas interface → store contract) end to end using
 * in-memory fakes only. It creates NO external state and never touches a real
 * database or Slack. All evidence it records is clearly labelled FIXTURE data
 * and does not simulate external creative quality.
 *
 * Run via `scripts/pilot-smoke.ts`, which refuses any remote/production target.
 */

import { makeFakeCanvas, makeFakePilotStore, type FakeCanvas, type FakePilotStore } from './fake-store'
import { runPilotCommand } from './command'
import { REQUIRED_MEASUREMENT_KEYS } from './types'
import type { ActorContext } from './service'
import type { PilotDeps } from './service'

export interface SmokeStep {
  name: string
  ok: boolean
  detail: string
}

export interface SmokeReport {
  passed: boolean
  steps: SmokeStep[]
  pilotId: string | null
}

const ACTOR: ActorContext = { actingUserId: 'FIXTURE_ARTIST', workspaceId: 'ws-fixture' }
const PROJECT_ID = 'project-fixture-0001'
const CHANNEL = 'C_FIXTURE'
let CLOCK = 0

function fixtureDeps(): { deps: PilotDeps; store: FakePilotStore; canvas: FakeCanvas } {
  const store = makeFakePilotStore()
  store.projectWorkspaces[PROJECT_ID] = ACTOR.workspaceId
  store.projectInfos[PROJECT_ID] = { status: 'active', workspace_id: ACTOR.workspaceId, slack_channel_id: CHANNEL }
  const canvas = makeFakeCanvas()
  // Deterministic clock — never Date.now(), so the harness is reproducible.
  const deps: PilotDeps = { store, canvas, now: () => `2026-01-01T00:00:${String(CLOCK++).padStart(2, '0')}.000Z` }
  return { deps, store, canvas }
}

export async function runSmoke(): Promise<SmokeReport> {
  CLOCK = 0
  const { deps, store, canvas } = fixtureDeps()
  const steps: SmokeStep[] = []
  const run = (args: string, gateEnabled = true) =>
    runPilotCommand(deps, { args, channelId: CHANNEL, actor: ACTOR, gateEnabled })
  const record = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail })

  // 1. Gate disabled → inert.
  const disabled = await run('help', false)
  record('gate_disabled', disabled.text.includes('not enabled'), disabled.text)

  // 2. Gate enabled: help + readiness (no project).
  const help = await run('help')
  record('help', help.text.includes('Kit Pilots'), 'help rendered')
  const readiness = await run(`readiness ${PROJECT_ID}`)
  record('readiness', readiness.text.includes('Pilot readiness'), 'readiness rendered')

  // 3. Create one pilot (FIXTURE).
  const created = await run(`create ${PROJECT_ID} :: FIXTURE Visual Dev Pilot`)
  const pilotId = store.pilots[0]?.id ?? null
  record('create', !!pilotId && created.text.includes('created'), created.text)
  if (!pilotId) return { passed: false, steps, pilotId: null }

  // 4. Premature finalize → blocked by completeness.
  const blocked = await run(`finalize ${pilotId} adopt :: FIXTURE rationale`)
  record('finalize_blocked', blocked.text.includes('Cannot finalize'), 'blocked before evidence')

  // 5. Record the full evidence set (FIXTURE data).
  await run(`ref ${pilotId} pinterest https://pinterest.example/fixture :: FIXTURE research`)
  await run(`ref ${pilotId} figma https://figma.example/fixture :: FIXTURE moodboard`)
  await run(`ref ${pilotId} styleframe - :: FIXTURE direction A`)
  await run(`visual-language ${pilotId} :: FIXTURE tactile neon, high-contrast`)
  const gen = await run(`generation ${pilotId} up://fixture-1 :: FIXTURE frame`)
  const genId = store.generations[0]?.id ?? null
  record('generation', !!genId && gen.text.includes('pending'), 'generation pending by default')
  if (genId) await run(`accept ${genId}`)
  record('accept', store.generations[0]?.acceptance === 'accepted', 'output human-accepted + attributed')

  await run(`map ${pilotId} FixtureSteel albedo :: FIXTURE base color`)
  await run(`map ${pilotId} FixtureSteel roughness :: FIXTURE microsurface`)
  await run(`validate ${pilotId} cinema4d pass c4d_fixture.png :: FIXTURE scene`)
  await run(`validate ${pilotId} redshift pass rs_fixture.exr :: FIXTURE render`)
  for (const key of REQUIRED_MEASUREMENT_KEYS) {
    await run(`evidence ${pilotId} measurement ${key} :: ${key} :: 1 unit`)
  }
  await run(`evidence ${pilotId} assumption :: FIXTURE :: none identified`)
  await run(`evidence ${pilotId} unknown :: FIXTURE :: long-run editability`)
  await run(`evidence ${pilotId} decision :: FIXTURE :: cost down, reuse likely`)

  // 6. Check + status read paths.
  const check = await run(`check ${pilotId}`)
  record('check_ready', check.text.includes('ready to finalize'), 'completeness check reports ready')
  const status = await run(`status ${pilotId}`)
  record('status', status.text.includes('Usable-output rate'), 'status view rendered')

  // 7. Canvas refresh: created once, then edited (no duplicate).
  await run(`show ${pilotId}`)
  const afterFirst = canvas.created
  await run(`show ${pilotId}`)
  record(
    'canvas_no_duplicate',
    canvas.created === 1 && afterFirst === 1 && canvas.edited >= 1,
    `created=${canvas.created} edited=${canvas.edited}`,
  )

  // 8. Finalize successfully (human-authored recommendation).
  const finalized = await run(`finalize ${pilotId} adopt :: FIXTURE trustworthy evidence supports adoption`)
  record('finalize_ok', finalized.text.includes('finalized'), finalized.text)
  record('pilot_finalized', store.pilots[0]?.status === 'finalized', `status=${store.pilots[0]?.status}`)

  const passed = steps.every((s) => s.ok)
  return { passed, steps, pilotId }
}
