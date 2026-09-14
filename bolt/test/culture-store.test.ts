import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newMeme } from '../../src/lib/culture/model'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }))
import { saveMeme } from '../../src/lib/culture/store'
const workspace = '11111111-1111-4111-8111-111111111111'
const item = { ...newMeme('custom','C12345678','UTC','22222222-2222-4222-8222-222222222222'), name:'Studio wins', revision:1, fire_date:'2026-09-14' }
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('SLACK_BOT_TOKEN','synthetic-token')
  vi.stubGlobal('fetch',mocks.fetch)
  mocks.fetch.mockRejectedValue(new Error('Slack unavailable'))
  mocks.rpc.mockImplementation(async (_name, args) => ({data:[{...args.p_item,revision:2}],error:null}))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it.each(['draft','paused'] as const)('saves a %s even when Slack is unreachable', async status => {
  expect((await saveMeme(workspace,'verified-admin',{...item,status},false)).status).toBe(status)
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('save_culture_meme',expect.objectContaining({p_workspace:workspace,p_actor:'verified-admin'}))
})
it('enabling still fails closed when destination verification is unavailable', async () => {
  await expect(saveMeme(workspace,'verified-admin',{...item,status:'enabled'},true)).rejects.toThrow()
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('a database rejection cannot masquerade as a successful pause', async () => {
  mocks.rpc.mockResolvedValue({data:null,error:{message:'conflict'}})
  await expect(saveMeme(workspace,'verified-admin',{...item,status:'paused'},false)).rejects.toThrow('Could not save')
})
