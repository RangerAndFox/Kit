import { afterEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const { post, select } = vi.hoisted(() => ({ post: vi.fn(), select: vi.fn() }))
vi.mock('../src/memes/meme-engine', () => ({ postMeme: post }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({ upsert: () => ({ select }) }) }) }))
import { postDeliveryCelebration } from '../src/celebrations/celebrations'
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })
it('celebrates prepared files, not confirmed shipment or client approval', async () => {
  vi.stubEnv('KIT_TEAM_CHANNEL_ID', 'C_FIXTURE')
  select.mockResolvedValue({ data: [{ id: 'claim' }], error: null })
  post.mockResolvedValue({ posted: true })
  expect(await postDeliveryCelebration({} as App, 'SecretClient Project123')).toBe(true)
  const options = post.mock.calls[0][1]
  expect(options.headline).toBe(':package: *Delivery files ready — SecretClient Project123*')
  expect(options.headline).not.toMatch(/shipped|delivered|approved/i)
  expect(options.publicOccasion).toBe('delivery_prepared')
  expect(options.briefing).not.toMatch(/SecretClient|Project123/)
})
it('retains one celebration per project/day when the claim already exists', async () => {
  vi.stubEnv('KIT_TEAM_CHANNEL_ID', 'C_FIXTURE')
  select.mockResolvedValue({ data: [], error: null })
  expect(await postDeliveryCelebration({} as App, 'Project123')).toBe(false)
  expect(post).not.toHaveBeenCalled()
})
