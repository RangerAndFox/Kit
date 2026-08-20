import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSlackChannel, kitChannelMarker } from './slack'
import { deriveSlackSlug } from '../provisioner/identifiers'

const origFetch = globalThis.fetch
const PROJECT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const input = {
  projectId: PROJECT_ID,
  projectNumber: '2601',
  client: 'Adidas',
  projectName: 'Summer Campaign',
}
const names = deriveSlackSlug(input)

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
})
afterEach(() => {
  globalThis.fetch = origFetch
})

function slackMock(handlers: Record<string, (body: any, url: URL) => any>) {
  const calls: Array<{ method: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = new URL(String(url))
    const method = u.pathname.split('/').pop() as string
    const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams)
    calls.push({ method, body })
    const data = handlers[method]?.(body, u) ?? { ok: true }
    return { ok: true, json: async () => data }
  }) as any
  return calls
}

describe('createProjectSlackChannel naming', () => {
  it('uses the clean human-facing name for a normal create', async () => {
    const calls = slackMock({
      'conversations.create': (body) => ({ ok: true, channel: { id: 'CNEW', name: body.name } }),
    })

    const result = await createProjectSlackChannel(input)

    assert.equal(result.channelName, '2601-adidas-summer-campaign')
    assert.equal(result.channelName, names.slackSlug)
    assert.equal(calls.find((c) => c.method === 'conversations.create')?.body.name, names.slackSlug)
    assert.equal(result.channelName.includes(names.slackShortId), false)
  })

  it('reuses a clean name from a prior attempt when its project marker matches', async () => {
    const calls = slackMock({
      'conversations.create': () => ({ ok: false, error: 'name_taken' }),
      'conversations.list': () => ({
        ok: true,
        channels: [{ id: 'CPRIOR', name: names.slackSlug, purpose: { value: kitChannelMarker(PROJECT_ID) } }],
      }),
    })

    const result = await createProjectSlackChannel(input)

    assert.equal(result.channelId, 'CPRIOR')
    assert.equal(result.channelName, names.slackSlug)
    assert.equal(calls.filter((c) => c.method === 'conversations.create').length, 1)
  })

  it('reuses a marker-less clean name only when the authenticated Kit bot created it', async () => {
    slackMock({
      'conversations.create': () => ({ ok: false, error: 'name_taken' }),
      'conversations.list': () => ({
        ok: true,
        channels: [{ id: 'CCRASH', name: names.slackSlug, creator: 'UKIT', purpose: { value: '' } }],
      }),
      'auth.test': () => ({ ok: true, user_id: 'UKIT' }),
    })

    const result = await createProjectSlackChannel(input)
    assert.equal(result.channelId, 'CCRASH')
    assert.equal(result.channelName, names.slackSlug)
  })

  it('uses the internal suffix only for a positively identified different project', async () => {
    const creates: string[] = []
    const calls = slackMock({
      'conversations.create': (body) => {
        creates.push(body.name)
        if (body.name === names.slackSlug) return { ok: false, error: 'name_taken' }
        return { ok: true, channel: { id: 'CCOLLISION', name: body.name } }
      },
      'conversations.list': () => ({
        ok: true,
        channels: [{
          id: 'COTHER',
          name: names.slackSlug,
          creator: 'UKIT',
          purpose: { value: '[kit:ffffffff-ffff-ffff-ffff-ffffffffffff]' },
        }],
      }),
    })

    const result = await createProjectSlackChannel(input)

    assert.deepEqual(creates, [names.slackSlug, names.slackCollisionSlug])
    assert.equal(result.channelName, names.slackCollisionSlug)
    assert.equal(calls.some((c) => c.method === 'auth.test'), false)
  })

  it('fails closed when a marker-less occupant cannot be authenticated', async () => {
    const creates: string[] = []
    slackMock({
      'conversations.create': (body) => {
        creates.push(body.name)
        return { ok: false, error: 'name_taken' }
      },
      'conversations.list': () => ({
        ok: true,
        channels: [{ id: 'CUNKNOWN', name: names.slackSlug, creator: 'UUNKNOWN', purpose: { value: '' } }],
      }),
      'auth.test': () => ({ ok: false, error: 'temporary_failure' }),
    })

    await assert.rejects(() => createProjectSlackChannel(input), /ownership could not be verified/)
    assert.deepEqual(creates, [names.slackSlug])
  })
})
