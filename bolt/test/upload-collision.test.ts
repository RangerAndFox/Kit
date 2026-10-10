import { describe, expect, it } from 'vitest'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
import { assertCollisionOwner, collisionCard, collisionChoices, collisionModal } from '../src/watchers/upload-collision'
const name = 'R&F_Client_Project_Edit_V1.mov'
const row = { id: 'request', state: 'collision', approved_name: name, approved_by: 'UPRODUCER', approval_version: 1 } as UploadApproval
const file = { id: 'existing', name, type: 'file' }
describe('conditional duplicate-name choices', () => {
  it('never offers Replace or Keep both without a same-name match', () => {
    expect(collisionChoices(row, [{ ...file, name: 'unrelated.mov' }]).map(c => c.decision)).toEqual(['new','skip'])
    expect(JSON.stringify(collisionModal(row, [])).includes('"value":"replace"')).toBe(false)
  })
  it.each(['file','version_stack'])('offers a non-default explicit choice for an existing %s', type => {
    const choices = collisionChoices(row, [{ ...file, type }])
    expect(choices).toEqual([
      { decision: 'replace', name, conflict: { id: 'existing', type } },
      { decision: 'keep_both', name: 'R&F_Client_Project_Edit_V1_02.mov' },
      { decision: 'skip', name },
    ])
    expect(JSON.stringify(collisionModal(row, [{ ...file, type }]))).not.toContain('initial_option')
  })
  it('avoids existing numbered names and compares case-insensitively', () => {
    const choices = collisionChoices(row, [{ ...file, name: name.toUpperCase() }, { ...file, id:'second',name:'R&F_Client_Project_Edit_V1_02.MOV' }])
    expect(choices.find(c=>c.decision==='keep_both')?.name).toBe('R&F_Client_Project_Edit_V1_03.mov')
  })
  it('never guesses which duplicate to replace', () => {
    expect(collisionChoices(row, [file,{...file,id:'other'}]).map(c=>c.decision)).toEqual(['keep_both','skip'])
    expect(collisionChoices(row, [{...file,type:'folder'}]).map(c=>c.decision)).toEqual(['keep_both','skip'])
  })
  it('only accepts the original approver on the current collision version', () => {
    expect(()=>assertCollisionOwner(row,'UCD',1)).toThrow(/Only the person/)
    expect(()=>assertCollisionOwner(row,'UPRODUCER',0)).toThrow(/changed/)
    expect(()=>assertCollisionOwner({...row,state:'approved'},'UPRODUCER',1)).toThrow(/already resolved/)
    expect(()=>assertCollisionOwner(row,'UPRODUCER',1)).not.toThrow()
  })
  it('removes private collision controls after the decision', () => {
    expect(collisionCard(row).blocks.some(b=>b.type==='actions')).toBe(true)
    expect(collisionCard({...row,state:'approved'}).blocks.some(b=>b.type==='actions')).toBe(false)
  })
})
