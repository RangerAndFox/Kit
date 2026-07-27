/**
 * Slack Events workspace-binding tests.
 *
 * Proves the resolver never yields a workspace id except on exactly one exact
 * binding, and that the unbound acknowledgement/log carry no sensitive material.
 * Pure — the lookup port is a fake, so no Supabase or provider is contacted.
 *
 * Run: npx tsx --test src/lib/slack/events-workspace.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setSlackEventPortsForTests,
  resolveBoundWorkspace,
  scheduleSlackWork,
  slackWorkspaceUnbound,
  SLACK_WORKSPACE_UNBOUND_BODY,
  type SlackScheduledWork,
  type WorkspaceBindingLookup,
} from './events-workspace'

const WS = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'

let scheduled: SlackScheduledWork[] = []
const realWarn = console.warn
let warnings: string[] = []

function setLookup(lookup: WorkspaceBindingLookup) {
  __setSlackEventPortsForTests({ lookup, scheduler: (w) => { scheduled.push(w) } })
}

beforeEach(() => {
  scheduled = []
  warnings = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
})

afterEach(() => {
  console.warn = realWarn
  __setSlackEventPortsForTests(null)
})

describe('resolveBoundWorkspace', () => {
  it('resolves exactly one exact binding', async () => {
    setLookup(async (teamId) => ({ ids: teamId === 'T1' ? [WS] : [] }))
    assert.deepEqual(await resolveBoundWorkspace('T1'), { ok: true, workspaceId: WS })
  })

  it('refuses an absent team_id without consulting the lookup', async () => {
    let called = 0
    setLookup(async () => { called++; return { ids: [WS] } })
    for (const value of [undefined, null, '', '   ', 42, {}]) {
      const r = await resolveBoundWorkspace(value)
      assert.deepEqual(r, { ok: false, reason: 'team_id_missing' })
    }
    assert.equal(called, 0)
  })

  it('refuses an unbound team — no fallback workspace', async () => {
    setLookup(async () => ({ ids: [] }))
    assert.deepEqual(await resolveBoundWorkspace('T-UNBOUND'), {
      ok: false,
      reason: 'workspace_binding_not_found',
    })
  })

  it('refuses a lookup failure rather than treating it as "not found"', async () => {
    setLookup(async () => { throw new Error('permission denied for relation workspaces') })
    assert.deepEqual(await resolveBoundWorkspace('T1'), {
      ok: false,
      reason: 'workspace_binding_lookup_failed',
    })
  })

  it('refuses an ambiguous binding instead of picking a row', async () => {
    setLookup(async () => ({ ids: [WS, OTHER] }))
    const r = await resolveBoundWorkspace('T1')
    assert.deepEqual(r, { ok: false, reason: 'workspace_binding_lookup_failed' })
  })

  it('refuses a blank workspace id', async () => {
    setLookup(async () => ({ ids: ['   '] }))
    assert.deepEqual(await resolveBoundWorkspace('T1'), {
      ok: false,
      reason: 'workspace_binding_lookup_failed',
    })
  })
})

describe('scheduleSlackWork', () => {
  it('hands the work to the injected scheduler with its workspace id', () => {
    setLookup(async () => ({ ids: [WS] }))
    const run = async () => {}
    scheduleSlackWork({ workspaceId: WS, run })
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].workspaceId, WS)
    assert.equal(scheduled[0].run, run)
  })
})

describe('slackWorkspaceUnbound', () => {
  const request = new Request('https://kit.example/api/webhooks/slack/events', {
    method: 'POST',
    headers: {
      'x-vercel-id': 'iad1::abc123',
      'x-slack-signature': 'v0=must-not-be-logged',
      authorization: 'Bearer must-not-be-logged',
    },
    body: 'super secret message text',
  })

  it('acknowledges with 200 so Slack does not retry-storm', async () => {
    const res = slackWorkspaceUnbound({ route: '/r', reason: 'workspace_binding_not_found', request })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), SLACK_WORKSPACE_UNBOUND_BODY)
    assert.deepEqual(SLACK_WORKSPACE_UNBOUND_BODY, { ok: true, ignored: 'workspace_unbound' })
  })

  it('logs one structured warning with only safe metadata', () => {
    slackWorkspaceUnbound({ route: '/r', reason: 'workspace_binding_lookup_failed', request })
    assert.equal(warnings.length, 1)
    const line = warnings[0]
    const parsed = JSON.parse(line)
    assert.equal(parsed.evt, 'slack_workspace_unbound')
    assert.equal(parsed.route, '/r')
    assert.equal(parsed.reason, 'workspace_binding_lookup_failed')
    assert.equal(parsed.request_id, 'iad1::abc123')
    assert.equal(parsed.team_id_present, true)
    assert.deepEqual(Object.keys(parsed).sort(), [
      'evt', 'reason', 'request_id', 'route', 'team_id_present',
    ])

    for (const forbidden of ['must-not-be-logged', 'v0=', 'Bearer', 'super secret message text']) {
      assert.ok(!line.includes(forbidden), `log must not contain ${forbidden}`)
    }
  })

  it('reports team_id_present=false only for the missing-team_id reason', () => {
    slackWorkspaceUnbound({ route: '/r', reason: 'team_id_missing', request })
    assert.equal(JSON.parse(warnings[0]).team_id_present, false)
  })
})
