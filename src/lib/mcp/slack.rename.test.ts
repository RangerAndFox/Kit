/**
 * renameProjectSlackChannel: reconciles by the Kit purpose marker (refuses a
 * non-owned channel → terminal), is idempotent when already at the target slug,
 * and treats a name_taken by THIS channel as done. The channel id never changes.
 *
 * Run: npx tsx --test src/lib/mcp/slack.rename.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renameProjectSlackChannel, SlackRenameTerminalError, kitChannelMarker } from './slack'
import { deriveSlackSlug, deriveSlackShortId } from '../provisioner/identifiers'

const origFetch = globalThis.fetch
const PROJECT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const CHANNEL = 'C123'

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
})
afterEach(() => {
  globalThis.fetch = origFetch
})

/**
 * Route Slack Web API calls (method taken from the URL path) through a handler
 * map. `conversations.info` is a GET with query string; the rest are POST JSON.
 */
function slackMock(handlers: Record<string, (body: any, url: URL) => any>) {
  const calls: Array<{ method: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = new URL(String(url))
    const method = u.pathname.split('/').pop() as string
    const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams)
    calls.push({ method, body })
    const h = handlers[method]
    const data = h ? h(body, u) : { ok: true }
    return { ok: true, json: async () => data }
  }) as any
  return calls
}

const targetNames = deriveSlackSlug({ projectId: PROJECT_ID, projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign' })
const target = targetNames.slackSlug
const collisionTarget = targetNames.slackCollisionSlug

describe('renameProjectSlackChannel', () => {
  it('renames when the marker is present and the slug differs', async () => {
    const calls = slackMock({
      'conversations.info': () => ({ ok: true, channel: { name: 'old-name-a1b2c3d4', purpose: { value: `x ${kitChannelMarker(PROJECT_ID)}` } } }),
      'conversations.rename': (b) => ({ ok: true, channel: { id: CHANNEL, name: b.name } }),
      'conversations.setPurpose': () => ({ ok: true }),
      'conversations.setTopic': () => ({ ok: true }),
    })
    const res = await renameProjectSlackChannel({ projectId: PROJECT_ID, channelId: CHANNEL, projectName: 'Summer Campaign', client: 'Adidas', projectNumber: '2601' })
    assert.equal(res.channelId, CHANNEL) // id unchanged
    assert.equal(res.channelName, target)
    const rename = calls.find((c) => c.method === 'conversations.rename')
    assert.ok(rename)
    assert.equal(rename!.body.name, target)
    assert.equal(rename!.body.channel, CHANNEL)
  })

  it('refuses (terminal) a channel with neither the marker nor a matching name suffix', async () => {
    slackMock({
      'conversations.info': () => ({ ok: true, channel: { name: 'someone-elses', purpose: { value: 'no marker here' } } }),
    })
    await assert.rejects(
      () => renameProjectSlackChannel({ projectId: PROJECT_ID, channelId: CHANNEL, projectName: 'Summer Campaign', client: 'Adidas', projectNumber: '2601' }),
      (err: unknown) => err instanceof SlackRenameTerminalError,
    )
  })

  it('accepts ownership by channel-name suffix when the purpose marker is missing, and backfills it', async () => {
    const shortId = deriveSlackShortId(PROJECT_ID)
    const calls = slackMock({
      // Marker dropped at create (swallowed setPurpose), but the name still carries
      // the stable short-id suffix — create's true identity.
      'conversations.info': () => ({ ok: true, channel: { name: `2601-nike-old-${shortId}`, purpose: { value: 'marker was never written' } } }),
      'conversations.rename': (b) => ({ ok: true, channel: { id: CHANNEL, name: b.name } }),
      'conversations.setPurpose': () => ({ ok: true }),
      'conversations.setTopic': () => ({ ok: true }),
    })
    const res = await renameProjectSlackChannel({ projectId: PROJECT_ID, channelId: CHANNEL, projectName: 'Summer Campaign', client: 'Adidas', projectNumber: '2601' })
    assert.equal(res.channelName, target)
    // The marker is backfilled via setPurpose, so the next rename self-heals.
    const sp = calls.find((c) => c.method === 'conversations.setPurpose')
    assert.ok(sp && String(sp.body.purpose).includes(kitChannelMarker(PROJECT_ID)))
  })

  it('accepts a legacy channel created by the authenticated Kit bot and backfills its marker', async () => {
    const calls = slackMock({
      'conversations.info': () => ({
        ok: true,
        channel: {
          name: '2601-adidas-old-project-undefined',
          creator: 'UKITBOT',
          purpose: { value: 'Adidas — Old Project [kit:undefined]' },
        },
      }),
      'auth.test': () => ({ ok: true, user_id: 'UKITBOT' }),
      'conversations.rename': (b) => ({ ok: true, channel: { id: CHANNEL, name: b.name } }),
      'conversations.setPurpose': () => ({ ok: true }),
      'conversations.setTopic': () => ({ ok: true }),
    })

    const res = await renameProjectSlackChannel({
      projectId: PROJECT_ID,
      channelId: CHANNEL,
      projectName: 'Summer Campaign',
      client: 'Adidas',
      projectNumber: '2601',
    })

    assert.equal(res.channelName, target)
    assert.ok(calls.some((c) => c.method === 'auth.test'))
    const sp = calls.find((c) => c.method === 'conversations.setPurpose')
    assert.ok(sp && String(sp.body.purpose).includes(kitChannelMarker(PROJECT_ID)))
  })

  it('still refuses a legacy-looking channel created by a different user', async () => {
    slackMock({
      'conversations.info': () => ({
        ok: true,
        channel: {
          name: '2601-adidas-old-project-undefined',
          creator: 'USOMEONEELSE',
          purpose: { value: 'Adidas — Old Project [kit:undefined]' },
        },
      }),
      'auth.test': () => ({ ok: true, user_id: 'UKITBOT' }),
    })

    await assert.rejects(
      () => renameProjectSlackChannel({
        projectId: PROJECT_ID,
        channelId: CHANNEL,
        projectName: 'Summer Campaign',
        client: 'Adidas',
        projectNumber: '2601',
      }),
      (err: unknown) => err instanceof SlackRenameTerminalError,
    )
  })

  it('refuses a channel marked for another project even when Kit created it', async () => {
    const calls = slackMock({
      'conversations.info': () => ({
        ok: true,
        channel: {
          name: '2601-adidas-old-project',
          creator: 'UKITBOT',
          purpose: { value: '[kit:ffffffff-ffff-ffff-ffff-ffffffffffff]' },
        },
      }),
      'auth.test': () => ({ ok: true, user_id: 'UKITBOT' }),
    })

    await assert.rejects(
      () => renameProjectSlackChannel({
        projectId: PROJECT_ID,
        channelId: CHANNEL,
        projectName: 'Summer Campaign',
        client: 'Adidas',
        projectNumber: '2601',
      }),
      (err: unknown) => err instanceof SlackRenameTerminalError,
    )
    assert.equal(calls.some((c) => c.method === 'auth.test'), false)
  })

  it('is a no-op rename when already at the target slug', async () => {
    const calls = slackMock({
      'conversations.info': () => ({ ok: true, channel: { name: target, purpose: { value: `x ${kitChannelMarker(PROJECT_ID)}` } } }),
      'conversations.setPurpose': () => ({ ok: true }),
      'conversations.setTopic': () => ({ ok: true }),
    })
    const res = await renameProjectSlackChannel({ projectId: PROJECT_ID, channelId: CHANNEL, projectName: 'Summer Campaign', client: 'Adidas', projectNumber: '2601' })
    assert.equal(res.channelName, target)
    assert.equal(calls.some((c) => c.method === 'conversations.rename'), false) // never called
  })

  it('treats name_taken by THIS channel as done', async () => {
    slackMock({
      'conversations.info': () => ({ ok: true, channel: { name: 'old-name', purpose: { value: `x ${kitChannelMarker(PROJECT_ID)}` } } }),
      'conversations.rename': () => { throw new Error('Slack conversations.rename: name_taken') },
      // findOwnedChannelByName lists channels; the target is owned by THIS channel.
      'conversations.list': () => ({ ok: true, channels: [{ id: CHANNEL, name: target, purpose: { value: `x ${kitChannelMarker(PROJECT_ID)}` } }] }),
      'conversations.setPurpose': () => ({ ok: true }),
      'conversations.setTopic': () => ({ ok: true }),
    })
    const res = await renameProjectSlackChannel({ projectId: PROJECT_ID, channelId: CHANNEL, projectName: 'Summer Campaign', client: 'Adidas', projectNumber: '2601' })
    assert.equal(res.channelName, target)
    assert.equal(res.channelId, CHANNEL)
  })

  it('uses the suffixed fallback only when another channel genuinely holds the clean name', async () => {
    const renameNames: string[] = []
    slackMock({
      'conversations.info': () => ({
        ok: true,
        channel: { name: 'old-name', purpose: { value: `x ${kitChannelMarker(PROJECT_ID)}` } },
      }),
      'conversations.rename': (body) => {
        renameNames.push(body.name)
        if (body.name === target) return { ok: false, error: 'name_taken' }
        return { ok: true, channel: { id: CHANNEL, name: body.name } }
      },
      'conversations.list': () => ({
        ok: true,
        channels: [{ id: 'COTHER', name: target, purpose: { value: '[kit:ffffffff-ffff-ffff-ffff-ffffffffffff]' } }],
      }),
      'conversations.setPurpose': () => ({ ok: true }),
      'conversations.setTopic': () => ({ ok: true }),
    })

    const res = await renameProjectSlackChannel({
      projectId: PROJECT_ID,
      channelId: CHANNEL,
      projectName: 'Summer Campaign',
      client: 'Adidas',
      projectNumber: '2601',
    })

    assert.deepEqual(renameNames, [target, collisionTarget])
    assert.equal(res.channelName, collisionTarget)
  })
})
