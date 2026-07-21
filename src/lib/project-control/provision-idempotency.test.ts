/**
 * Crash-after-create-before-ledger-update idempotency — the REAL provisioning
 * reconciliation paths for Harvest, Frame.io, and Slack, driven by a stateful
 * global.fetch stub (no network). Each proves: a resume (second provision of the
 * same Kit project) reconciles to the resource the first attempt created instead
 * of creating a duplicate.
 *
 * Run: npx tsx --test src/lib/project-control/provision-idempotency.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createHarvestProject, findHarvestProjectByKitId, kitProjectMarker } from '../harvest/client'
import { createProjectSlackChannel, kitChannelMarker } from '../mcp/slack'
import { findFrameioProjectByLabel } from '../inngest/agents/frameio'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ─── Harvest ─────────────────────────────────────────────────────────────────

describe('Harvest reconcile (crash-after-create resume)', () => {
  beforeEach(() => {
    process.env.HARVEST_ACCESS_TOKEN = 't'
    process.env.HARVEST_ACCOUNT_ID = 'a'
  })

  it('embeds the Kit marker on create and finds the project by Kit id on resume', async () => {
    const projects: Array<{ id: number; name: string; code: string; is_active: boolean; notes: string; client: { id: number; name: string } }> = []
    let created = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method || 'GET'
      if (u.includes('/projects') && method === 'POST') {
        created++
        const body = JSON.parse(init!.body as string)
        const row = { id: 100 + created, name: body.name, code: body.code || '', is_active: true, notes: body.notes || '', client: { id: 1, name: 'Nike' } }
        projects.push(row)
        return jsonResponse(row)
      }
      if (u.includes('/tasks')) return jsonResponse({ tasks: [] }) // no tasks → assignDefaultTasks no-ops
      if (u.includes('/projects')) return jsonResponse({ projects, next_page: null })
      return jsonResponse({})
    }) as unknown as typeof fetch

    const p1 = await createHarvestProject({ name: 'Sizzle', clientId: 1, code: '2601-Nike', kitProjectId: 'KP1' })
    assert.ok(p1.id)
    assert.equal(created, 1)
    // The create embedded the marker...
    assert.ok(projects[0].notes.includes(kitProjectMarker('KP1')))
    // ...so a resume reconciles by Kit id to the SAME project (no second create).
    const found = await findHarvestProjectByKitId('KP1')
    assert.ok(found)
    assert.equal(found!.id, p1.id)
    assert.equal(created, 1)
    // A different Kit id does not match.
    assert.equal(await findHarvestProjectByKitId('OTHER'), null)
  })
})

// ─── Frame.io ────────────────────────────────────────────────────────────────

describe('Frame.io reconcile (crash-after-create resume)', () => {
  beforeEach(() => {
    process.env.FRAMEIO_ACCOUNT_ID = 'acct'
    process.env.FRAMEIO_WORKSPACE_ID = 'ws'
    process.env.FRAMEIO_TOKEN = 'static' // static-token path, no Adobe/Supabase
    delete process.env.FRAMEIO_ADOBE_CLIENT_ID
  })

  it('finds an existing workspace project by its deterministic label', async () => {
    const workspaceProjects = [
      { id: 'F1', name: '2628_Crunchyroll_Expo', root_folder_id: 'root1' },
      { id: 'F2', name: 'unrelated', root_folder_id: 'root2' },
    ]
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/workspaces/ws/projects')) return jsonResponse({ data: workspaceProjects })
      return jsonResponse({ data: [] })
    }) as unknown as typeof fetch

    const hit = await findFrameioProjectByLabel('acct', 'ws', '2628_Crunchyroll_Expo')
    assert.ok(hit)
    assert.equal(hit!.id, 'F1')
    assert.equal(hit!.rootFolderId, 'root1')
    // A label with no match → null (provision then creates, absence proven).
    assert.equal(await findFrameioProjectByLabel('acct', 'ws', 'nope'), null)
  })
})

// ─── Slack ───────────────────────────────────────────────────────────────────

describe('Slack reconcile (crash-after-create resume)', () => {
  beforeEach(() => { process.env.SLACK_BOT_TOKEN = 'xoxb-test' })

  it('reuses the existing channel on resume instead of creating a suffixed duplicate', async () => {
    const channels: Array<{ id: string; name: string; purpose: { value: string } }> = []
    let createCalls = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? JSON.parse(init.body as string) : {}
      if (u.includes('conversations.create')) {
        createCalls++
        if (channels.some((c) => c.name === body.name)) return jsonResponse({ ok: false, error: 'name_taken' })
        const ch = { id: `C${channels.length + 1}`, name: body.name, purpose: { value: '' } }
        channels.push(ch)
        return jsonResponse({ ok: true, channel: { id: ch.id, name: ch.name } })
      }
      if (u.includes('conversations.setPurpose')) {
        const ch = channels.find((c) => c.id === body.channel)
        if (ch) ch.purpose.value = body.purpose
        return jsonResponse({ ok: true })
      }
      if (u.includes('conversations.setTopic')) return jsonResponse({ ok: true })
      if (u.includes('conversations.list')) return jsonResponse({ ok: true, channels, response_metadata: {} })
      return jsonResponse({ ok: true })
    }) as unknown as typeof fetch

    const args = { projectId: 'KP1', projectName: 'Sizzle', client: 'Nike', projectNumber: '2601' }
    const r1 = await createProjectSlackChannel(args)
    const r2 = await createProjectSlackChannel(args) // resume

    // Exactly one channel exists; the resume reused it (same id), no suffix.
    assert.equal(channels.length, 1)
    assert.equal(r1.channelId, r2.channelId)
    assert.equal(r2.channelName, r1.channelName)
    // The channel carries the embedded Kit marker (so reconcile could find it).
    assert.ok(channels[0].purpose.value.includes(kitChannelMarker('KP1')))
    // create was attempted twice (2nd hit name_taken → reconciled), never suffixed.
    assert.equal(createCalls, 2)
    assert.ok(!r2.channelName.includes(args.projectId.slice(0, 8)))
  })
})
