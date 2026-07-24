/**
 * Command-dispatcher (production command path) tests — the handler-level
 * coverage for Workstream 6, exercised without live Slack/Supabase.
 *
 * Run: npx tsx --test src/lib/pilots/command.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runPilotCommand } from './command'
import { makeFakeCanvas, makeFakePilotStore, type FakePilotStore } from './fake-store'
import { REQUIRED_MEASUREMENT_KEYS } from './types'
import type { ActorContext } from './service'
import type { PilotCanvasPort, PilotDeps } from './service'

const ACTOR: ActorContext = { actingUserId: 'U1', workspaceId: 'ws' }
const CH = 'C1'

function make(canvas?: PilotCanvasPort): { deps: PilotDeps; store: FakePilotStore } {
  const store = makeFakePilotStore()
  store.projectWorkspaces['proj'] = 'ws'
  store.projectInfos['proj'] = { status: 'active', workspace_id: 'ws', slack_channel_id: 'C1' }
  return { deps: { store, canvas: canvas ?? makeFakeCanvas(), now: () => '2026-01-01T00:00:00.000Z' }, store }
}
const run = (deps: PilotDeps, args: string, gateEnabled = true, actor: ActorContext = ACTOR) =>
  runPilotCommand(deps, { args, channelId: CH, actor, gateEnabled })

async function createPilot(deps: PilotDeps, store: FakePilotStore): Promise<string> {
  await run(deps, 'create proj :: T')
  return store.pilots[0].id
}

describe('runPilotCommand — gate + parsing safety', () => {
  it('gate disabled → inert notice, no state', async () => {
    const { deps, store } = make()
    const r = await run(deps, 'create proj :: T', false)
    assert.match(r.text, /not enabled/)
    assert.equal(store.pilots.length, 0)
  })
  it('help lists commands', async () => {
    const { deps } = make()
    assert.match((await run(deps, 'help')).text, /Kit Pilots/)
  })
  it('malformed command returns usage with NO side effect', async () => {
    const { deps, store } = make()
    const r = await run(deps, 'ref p1 bogus')
    assert.match(r.text, /ref type must be one of/)
    assert.equal(store.references.length, 0)
  })
})

describe('runPilotCommand — authorization', () => {
  it('create rejects unknown project', async () => {
    const { deps } = make()
    assert.match((await run(deps, 'create ghost :: T')).text, /project_not_found/)
  })
  it('create rejects a foreign workspace (workspace derived from project)', async () => {
    const { deps, store } = make()
    const r = await run(deps, 'create proj :: T', true, { actingUserId: 'V', workspaceId: 'evil' })
    assert.match(r.text, /unauthorized:wrong_workspace/)
    assert.equal(store.pilots.length, 0)
  })
  it('status/check reject a foreign workspace', async () => {
    const { deps, store } = make()
    const id = await createPilot(deps, store)
    assert.match((await run(deps, `status ${id}`, true, { actingUserId: 'V', workspaceId: 'evil' })).text, /Not authorized/)
    assert.match((await run(deps, `check ${id}`, true, { actingUserId: 'V', workspaceId: 'evil' })).text, /Not authorized/)
  })
  it('status reports not found for unknown pilot', async () => {
    const { deps } = make()
    assert.match((await run(deps, 'status nope')).text, /not found/)
  })
})

describe('runPilotCommand — lifecycle', () => {
  it('create then duplicate active pilot rejected', async () => {
    const { deps, store } = make()
    const id = await createPilot(deps, store)
    assert.ok(id)
    assert.match((await run(deps, 'create proj :: T2')).text, /active_pilot_exists/)
  })

  it('generation acceptance is attributed to the actor', async () => {
    const { deps, store } = make()
    const id = await createPilot(deps, store)
    await run(deps, `generation ${id} up://1 :: f`)
    const gid = store.generations[0].id
    assert.match((await run(deps, `accept ${gid}`)).text, /accepted/)
    assert.equal(store.generations[0].accepted_by, 'U1')
  })

  it('readiness renders structured checks', async () => {
    const { deps } = make()
    const r = await run(deps, 'readiness proj')
    assert.match(r.text, /Pilot readiness/)
    assert.match(r.text, /Human-required inputs/)
  })

  it('finalize blocked by completeness, then succeeds when complete', async () => {
    const { deps, store } = make()
    const id = await createPilot(deps, store)
    const blocked = await run(deps, `finalize ${id} adopt :: r`)
    assert.match(blocked.text, /Cannot finalize/)
    assert.equal(store.pilots[0].status, 'active')

    // Complete the evidence via the command path.
    await run(deps, `ref ${id} pinterest https://p :: r`)
    await run(deps, `ref ${id} figma https://f :: m`)
    await run(deps, `ref ${id} styleframe - :: dir`)
    await run(deps, `visual-language ${id} :: neon`)
    await run(deps, `generation ${id} up://1 :: f`)
    await run(deps, `accept ${store.generations[0].id}`)
    await run(deps, `map ${id} Steel albedo :: base`)
    await run(deps, `validate ${id} cinema4d pass c.png :: s`)
    await run(deps, `validate ${id} redshift pass r.exr :: s`)
    for (const k of REQUIRED_MEASUREMENT_KEYS) await run(deps, `evidence ${id} measurement ${k} :: ${k} :: 1 u`)
    await run(deps, `evidence ${id} assumption :: a :: none`)
    await run(deps, `evidence ${id} unknown :: u :: tbd`)
    await run(deps, `evidence ${id} decision :: d :: supports`)

    assert.match((await run(deps, `check ${id}`)).text, /ready to finalize/)
    const ok = await run(deps, `finalize ${id} adopt :: trustworthy`)
    assert.match(ok.text, /finalized/)
    assert.equal(store.pilots[0].status, 'finalized')
    assert.equal(store.pilots[0].recommendation, 'adopt')
    assert.equal(store.pilots[0].recommendation_by, 'U1')
  })
})

describe('runPilotCommand — Canvas observability', () => {
  it('refresh edits the existing canvas without duplicating', async () => {
    const { deps, store } = make()
    const id = await createPilot(deps, store)
    const canvas = deps.canvas as ReturnType<typeof makeFakeCanvas>
    await run(deps, `show ${id}`)
    await run(deps, `show ${id}`)
    assert.equal(canvas.created, 1)
    assert.ok(canvas.edited >= 1)
  })

  it('a Canvas failure returns a safe retry message and does not corrupt pilot state', async () => {
    const throwing: PilotCanvasPort = {
      createPilotCanvas: async () => { throw new Error('slack down') },
      editPilotCanvas: async () => { throw new Error('slack down') },
    }
    const { deps, store } = make(throwing)
    const id = await createPilot(deps, store)
    const r = await run(deps, `show ${id}`)
    assert.match(r.text, /Canvas refresh failed/)
    assert.match(r.text, /re-run/)
    // canvas_id stays null → retry re-creates, never a duplicate binding.
    assert.equal(store.pilots[0].canvas_id, null)
    assert.equal(store.pilots[0].status, 'active')
  })
})
