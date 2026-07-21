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
import { findFrameioProjectsByKitId, frameioKitMarker, copyFrameioFolderTree } from '../inngest/agents/frameio'

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

  it('reconciles by the Kit UUID marker, not business fields; explicit 0/1/multiple', async () => {
    // Two intentional Kit duplicates share identical business fields but have
    // DISTINCT kit markers → each reconciles only to its own project.
    const KA = 'aaaaaaaa-1111', KB = 'bbbbbbbb-2222'
    const workspaceProjects = [
      { id: 'F_A', name: `2628_Crunchyroll_Expo ${frameioKitMarker(KA)}`, root_folder_id: 'rootA' },
      { id: 'F_B', name: `2628_Crunchyroll_Expo ${frameioKitMarker(KB)}`, root_folder_id: 'rootB' },
      { id: 'F_DUP1', name: `9_X_Y ${frameioKitMarker('dup')}`, root_folder_id: 'r1' },
      { id: 'F_DUP2', name: `9_X_Y ${frameioKitMarker('dup')}`, root_folder_id: 'r2' },
    ]
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/workspaces/ws/projects')) return jsonResponse({ data: workspaceProjects })
      return jsonResponse({ data: [] })
    }) as unknown as typeof fetch

    // 1 match — the two business-identical duplicates do NOT cross-match.
    const a = await findFrameioProjectsByKitId('acct', 'ws', KA)
    assert.equal(a.length, 1)
    assert.equal(a[0].id, 'F_A')
    // 0 matches → provision would create (absence proven).
    assert.equal((await findFrameioProjectsByKitId('acct', 'ws', 'nope')).length, 0)
    // multiple matches → caller treats as actionable ambiguity.
    assert.equal((await findFrameioProjectsByKitId('acct', 'ws', 'dup')).length, 2)
  })

  it('crash midway through nested template-folder copy: find-or-create does not duplicate', async () => {
    // Source tree: root → A → A1 ; Dest already has A (from a prior crashed run)
    // but not A1. A resume must reuse A and only create A1.
    const source: Record<string, Array<{ id: string; name: string; type: string }>> = {
      srcRoot: [{ id: 'sA', name: 'A', type: 'folder' }],
      sA: [{ id: 'sA1', name: 'A1', type: 'folder' }],
    }
    const destChildren: Record<string, Array<{ id: string; name: string; type: string }>> = {
      dstRoot: [{ id: 'dA', name: 'A', type: 'folder' }], // A already exists
      dA: [],
    }
    const created: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const m = u.match(/folders\/([^/]+)\/children/)
      if (m) {
        const id = m[1]
        return jsonResponse({ data: source[id] ?? destChildren[id] ?? [] })
      }
      if (u.includes('/folders/') && u.endsWith('/folders') && init?.method === 'POST') {
        const parent = u.match(/folders\/([^/]+)\/folders$/)![1]
        const body = JSON.parse(init!.body as string)
        const newId = `new-${body.data.name}`
        created.push(`${parent}:${body.data.name}`)
        ;(destChildren[parent] ||= []).push({ id: newId, name: body.data.name, type: 'folder' })
        destChildren[newId] ||= []
        return jsonResponse({ data: { id: newId, name: body.data.name } })
      }
      return jsonResponse({ data: {} })
    }) as unknown as typeof fetch

    const res = await copyFrameioFolderTree('acct', 'srcRoot', 'dstRoot', 0)
    // A was reused (not recreated); only A1 created under the existing A.
    assert.deepEqual(created, ['dA:A1'])
    assert.equal(res.created, 1)
  })
})

// ─── Slack ───────────────────────────────────────────────────────────────────

describe('Slack reconcile (deterministic name + crash-after-create resume)', () => {
  beforeEach(() => { process.env.SLACK_BOT_TOKEN = 'xoxb-test' })

  type Ch = { id: string; name: string; purpose: { value: string } }
  function slackFetch(channels: Ch[], counters: { create: number }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? JSON.parse(init.body as string) : {}
      if (u.includes('conversations.create')) {
        counters.create++
        if (channels.some((c) => c.name === body.name)) return jsonResponse({ ok: false, error: 'name_taken' })
        const ch: Ch = { id: `C${channels.length + 1}`, name: body.name, purpose: { value: '' } }
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
  }
  const shortId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()

  it('deterministic name embeds the Kit short id; a resume reuses it (no second channel)', async () => {
    const channels: Ch[] = []
    const counters = { create: 0 }
    globalThis.fetch = slackFetch(channels, counters)
    const args = { projectId: 'KP1abcd9', projectName: 'Sizzle', client: 'Nike', projectNumber: '2601' }
    const r1 = await createProjectSlackChannel(args)
    const r2 = await createProjectSlackChannel(args) // resume
    assert.equal(channels.length, 1)
    assert.equal(r1.channelId, r2.channelId)
    assert.equal(r1.channelName, r2.channelName)
    assert.ok(r1.channelName.endsWith(`-${shortId(args.projectId)}`))
    assert.equal(counters.create, 2) // 2nd create → name_taken → reconciled by exact name
  })

  it('crash after conversations.create but before setPurpose: resume reuses the same channel', async () => {
    const args = { projectId: 'KP2wxyz1', projectName: 'Sizzle', client: 'Nike', projectNumber: '2602' }
    const name = `2602-nike-sizzle-${shortId(args.projectId)}`
    // Pre-seed a channel with the deterministic name but EMPTY purpose (marker
    // never got written — the crash-before-setPurpose window).
    const channels: Ch[] = [{ id: 'C_PRE', name, purpose: { value: '' } }]
    const counters = { create: 0 }
    globalThis.fetch = slackFetch(channels, counters)
    const r = await createProjectSlackChannel(args)
    assert.equal(r.channelId, 'C_PRE') // reused by exact name despite no marker
    assert.equal(channels.length, 1) // no second channel
  })

  it('an unrelated readable-name collision (base name, no Kit suffix) is NOT adopted', async () => {
    const args = { projectId: 'KP3aaaa2', projectName: 'Sizzle', client: 'Nike', projectNumber: '2603' }
    // A human-made channel shares the BASE name but lacks our -shortId suffix.
    const channels: Ch[] = [{ id: 'C_HUMAN', name: '2603-nike-sizzle', purpose: { value: '' } }]
    const counters = { create: 0 }
    globalThis.fetch = slackFetch(channels, counters)
    const r = await createProjectSlackChannel(args)
    assert.notEqual(r.channelId, 'C_HUMAN') // did not adopt the unrelated channel
    assert.ok(r.channelName.endsWith(`-${shortId(args.projectId)}`))
    assert.equal(channels.length, 2) // created our own distinct deterministic channel
  })
})
