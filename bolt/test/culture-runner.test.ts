import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import { newMeme } from '../../src/lib/culture/model'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), update: vi.fn(), verify: vi.fn(), workspace: vi.fn(), lookup: vi.fn(), sends: vi.fn(), post: vi.fn(), list: vi.fn(), save: vi.fn() }))
vi.mock('../../src/lib/culture/store', () => ({
  cultureDb: () => ({
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.lookup, order: () => ({ limit: mocks.list }) }) }),
      update: (...args: unknown[]) => {
        mocks.update(...args)
        return { eq: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }) }
      },
    }),
  }),
  workspaceForTeam: mocks.workspace, verifyDestination: mocks.verify, MEME_FIELDS: '', saveMeme: mocks.save,
}))
vi.mock('../src/memes/meme-engine', () => ({ CELEBRATION_TEMPLATES: [{id:'61544'}], postMeme: mocks.post }))
vi.mock('../src/memes/timesheet-meme', () => ({ postWeeklyTimesheetMeme: vi.fn(), weekIndexFromMs: () => 1 }))
import { cultureIsActive, managedBirthday, managedCelebration, postCultureItem } from '../src/culture/runner'
const config = { workspace_id: '11111111-1111-4111-8111-111111111111', starts_at: '2020-01-01T00:00:00Z', default_channel_id: 'C12345678', timezone: 'UTC', heartbeat_at: null }
const item = { ...newMeme('delivery','C12345678','UTC','22222222-2222-4222-8222-222222222222'), revision:1, status:'enabled' as const }
const app = () => ({ client: { auth: { test: async () => ({ ok:true, team_id:'T12345678' }) }, users: { info: async () => ({ ok:true, user:{real_name:'Jordan Lee'} }) } } }) as unknown as App
beforeEach(() => {
  vi.resetAllMocks()
  mocks.workspace.mockResolvedValue(config.workspace_id)
  mocks.lookup.mockResolvedValue({ data: config, error: null })
  mocks.verify.mockResolvedValue(undefined)
  mocks.list.mockResolvedValue({data:[],error:null})
  mocks.rpc.mockImplementation(async (name: string) => ({ error:null, data:name === 'claim_culture_post' ? {id:'33333333-3333-4333-8333-333333333333'} : true }))
  mocks.post.mockImplementation(async (_app: App, options: { beforeSend: () => Promise<void> }) => { await options.beforeSend(); mocks.sends(); return {posted:true,ts:'123.456'} })
})
it.each(['draft','paused','enabled'] as const)('birthday commands preserve an existing %s rule and its revision', async status => {
  const birthday = {...newMeme('birthday','C12345678','UTC','22222222-2222-4222-8222-222222222222'), name:'Jordan’s birthday', person_id:'U12345678', person_name:'Jordan Lee', month_day:'09-20', revision:7, status}
  mocks.list.mockResolvedValue({data:[birthday],error:null})
  expect(await managedBirthday(app(),'U12345678','09-21','Jordan Lee','U87654321')).toBe(true)
  expect(mocks.save).toHaveBeenCalledWith(config.workspace_id,'U87654321',expect.objectContaining({status,revision:7,month_day:'09-21'}),true,'birthday:U12345678')
  expect(mocks.post).not.toHaveBeenCalled()
})
it('new Slack birthdays retain the existing opt-in behavior', async () => {
  await managedBirthday(app(),'U12345678','09-20','Jordan Lee','U87654321')
  expect(mocks.save).toHaveBeenCalledWith(config.workspace_id,'U87654321',expect.objectContaining({status:'enabled',revision:0}),true,'birthday:U12345678')
})
it.each(['array', 'object'])('managed posting handles a %s RPC claim, verifies destination and records a private-safe ack', async shape => {
  mocks.rpc.mockImplementation(async (name: string) => {
    const row = {id:'33333333-3333-4333-8333-333333333333'}
    return {error:null,data:name === 'claim_culture_post' ? (shape === 'array' ? [row] : row) : true}
  })
  expect(await postCultureItem(app(),config,item,'2026-09-14:project','Secret client project')).toBe(true)
  expect(mocks.verify).toHaveBeenCalledWith(config.workspace_id,item.channel_id)
  expect(mocks.sends).toHaveBeenCalledTimes(1)
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({status:'posted',slack_ts:'123.456'}))
  expect(JSON.stringify(mocks.post.mock.calls)).not.toContain('Secret client project')
})
it('an already claimed occurrence performs no generation or Slack send', async () => {
  mocks.rpc.mockResolvedValue({data:null,error:null})
  expect(await postCultureItem(app(),config,item,'day')).toBe(false)
  expect(mocks.post).not.toHaveBeenCalled()
})
it('a changed configuration is fenced before the Slack side effect', async () => {
  mocks.rpc.mockImplementation(async (name:string)=>({error:null,data:name==='claim_culture_post'?[{id:'33333333-3333-4333-8333-333333333333'}]:false}))
  expect(await postCultureItem(app(),config,item,'day')).toBe(false)
  expect(mocks.sends).not.toHaveBeenCalled()
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}))
})
it('unverified destinations fail before generation or sending', async () => {
  mocks.verify.mockRejectedValue(new Error('external channel'))
  expect(await postCultureItem(app(),config,item,'day')).toBe(false)
  expect(mocks.post).not.toHaveBeenCalled()
})
it('database outages do not reactivate the legacy scheduler', async () => {
  mocks.lookup.mockResolvedValue({data:null,error:{code:'08006'}})
  await expect(cultureIsActive(app())).rejects.toThrow('posting paused')
  mocks.lookup.mockResolvedValue({data:null,error:{code:'42P01'}})
  expect(await cultureIsActive(app())).toBe(false)
  mocks.lookup.mockResolvedValue({data:config,error:null})
  expect(await cultureIsActive(app())).toBe(true)
})
it('a mismatched/unmapped Slack team fails closed', async () => {
  mocks.workspace.mockRejectedValue(new Error('unknown team'))
  await expect(cultureIsActive(app())).rejects.toThrow('unknown team')
  expect(mocks.lookup).not.toHaveBeenCalled()
})
it('an immediate celebration before handover creates no managed record', async () => {
  mocks.lookup.mockResolvedValue({data:{...config, starts_at:new Date(Date.now()+3600000).toISOString()},error:null})
  expect(await managedCelebration(app(),'Studio wins',null)).toBeNull()
  expect(mocks.lookup).toHaveBeenCalledTimes(1)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.post).not.toHaveBeenCalled()
})
