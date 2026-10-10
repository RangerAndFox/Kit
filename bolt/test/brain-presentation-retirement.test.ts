import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import type { App } from '@slack/bolt'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), apply: vi.fn(), propose: vi.fn(), filter: vi.fn(), classify: vi.fn(), catches: vi.fn(),
}))
vi.mock('../../src/lib/brain/store', () => ({getBrainByChannel:mocks.get,applyPatches:mocks.apply,getBrainById:mocks.get}))
vi.mock('../../src/lib/brain/writer', () => ({proposePatches:mocks.propose,filterForAutoApply:mocks.filter,classifySignal:mocks.classify}))
vi.mock('../../src/lib/brain/flagger', () => ({checkMessageForMistakes:mocks.catches,recordKitAction:vi.fn()}))
vi.mock('../../src/lib/brain/seed', () => ({seedBrainForChannel:vi.fn()}))
import { handleBrainIngestMessage, handleBrainIngestNote } from '../src/brain/handler'
import { brainAgent } from '../../src/lib/inngest/agents/brain'

describe('retired Brain presentation preserves memory', () => {
  beforeEach(()=>{
    vi.clearAllMocks()
    mocks.get.mockResolvedValue({row:{id:'brain',visibility:'producers_only',canvas_id:'legacy'},brain:{}})
    mocks.propose.mockResolvedValue({changes_understanding:true,patches:[{text:'Approved decision'}]})
    mocks.filter.mockReturnValue({applied:[{text:'Approved decision'}],skipped_low_conf:[]})
    mocks.classify.mockReturnValue(null)
    mocks.catches.mockResolvedValue({catches:[]})
  })
  const apiAccess = vi.fn(()=>{throw Error('No Slack API calls allowed for memory-only update')})
  const app = {client:new Proxy({}, {get:apiAccess})} as App
  it('still persists a message-derived patch without any canvas or Slack calls',async()=>{
    await handleBrainIngestMessage({app,channelId:'C1',userId:'U1',workspaceId:'w',messageText:'Approved new direction',messageTs:'1791638115.001'})
    expect(mocks.apply).toHaveBeenCalledWith({brainId:'brain',patches:[{text:'Approved decision'}],author:'U1'})
    expect(apiAccess).not.toHaveBeenCalled()
  })
  it('still persists a note-derived patch without any canvas or Slack calls',async()=>{
    await handleBrainIngestNote({app,channelId:'C1',userId:'U1',workspaceId:'w',noteText:'Approved note'})
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(apiAccess).not.toHaveBeenCalled()
  })
  it('does not advertise refresh, and an old refresh request truthfully reports retirement',async()=>{
    expect(brainAgent.capabilities.some(c=>c.action==='refresh_canvas')).toBe(false)
    const result=await brainAgent.handler('refresh_canvas',{})
    expect(result.success).toBe(false)
    expect(result.error).toContain('retired')
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('removes every former publishing entry point, not just the visible tab',()=>{
    for (const path of ['src/handlers/commands.ts','src/handlers/interactions.ts','src/brain/approvals.ts','src/brain/handler.ts']) {
      const body=readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
      expect(body).not.toMatch(/createOrUpdateBrainCanvas|refreshCanvasAfterPatch|brain\/canvas|setCanvasHandle/)
    }
    expect(existsSync(new URL('../../src/lib/brain/canvas.ts',import.meta.url))).toBe(false)
    const commands=readFileSync(new URL('../src/handlers/commands.ts',import.meta.url),'utf8')
    expect(commands).toContain('Project memory (${loaded.row.visibility})')
    expect(commands).toContain("if (user.tier === 'artist')")
  })
})
