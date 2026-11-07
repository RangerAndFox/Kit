import { describe, expect, it } from 'vitest'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
import { parseUploadPackageLocation, type UploadPackagePage } from '../../src/lib/delivery/upload-package'
import { uploadPackageCard, uploadPackageModal } from '../src/watchers/upload-package-card'

const id='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222'
const root='/production/2026/2645_Microsoft_Cloud_PC/09_Outgoing/02_Delivery/110626'
const row=(n:number,state='awaiting')=>({id:`request-${n}`,state,source_path:`${root}/03_Stills/Still_${n}.jpg`,suggested_name:`R&F_Client_Project_${n}.jpg`,approved_name:null,approved_by:null}) as UploadApproval
const page:UploadPackagePage={package:{id,root_path:root,workspace_id:'ws',project_id:'project',generation:1,notice_dirty:true,slack_channel_id:null,slack_message_ts:null},approvals:[row(1),row(2,'complete'),row(3,'collision')],total:15,awaiting:13,next_cursor:next}

describe('delivery folder review presentation',()=>{
  it('has one package entry point and no per-file controls or bulk approval in the shared message',()=>{
    const card=uploadPackageCard(page,'2645 — Cloud PC')
    const serialized=JSON.stringify(card)
    expect(serialized).toContain(root);expect(serialized).toContain('15 files');expect(serialized).toContain('13 awaiting')
    expect(serialized).toContain('kit_delivery_package_open')
    expect(serialized).not.toContain('kit_frame_upload_review');expect(serialized).not.toContain('request-1')
  })
  it('exposes rename and skip only for current awaiting files without collision controls',()=>{
    const modal=uploadPackageModal(page)
    expect(modal.submit).toBeUndefined()
    const controls=modal.blocks.filter(b=>b.type==='actions')
    expect(controls).toHaveLength(2)
    expect(JSON.stringify(controls[0])).toContain('request-1')
    expect(JSON.stringify(controls)).not.toContain('request-2');expect(JSON.stringify(controls)).not.toContain('request-3')
    expect(JSON.stringify(modal)).toContain('original approver')
    expect(JSON.stringify(modal)).toContain('Next files')
  })
  it('uses bounded pages and preserves the cursor for refresh while offering first page',()=>{
    const modal=uploadPackageModal(page,next)
    expect(parseUploadPackageLocation(modal.private_metadata!)).toEqual({id,after:next})
    expect(JSON.stringify(modal)).toContain('First page')
    const full=uploadPackageModal({...page,approvals:Array.from({length:10},(_,i)=>row(i))})
    expect(full.blocks.length).toBeLessThan(30)
  })
  it('escapes source text and bounds unusually long paths',()=>{
    const hostile={...page,approvals:[{...row(1),source_path:root+'/03_Stills/<@EVERYONE>&'+ 'x'.repeat(4000)}]}
    const modal=uploadPackageModal(hostile)
    expect(JSON.stringify(modal)).not.toContain('<@EVERYONE>')
    expect(JSON.stringify(modal)).toContain('&lt;@EVERYONE&gt;')
    for(const block of modal.blocks) if(block.type==='section'&&block.text) expect(block.text.text.length).toBeLessThan(3000)
  })
  it('rejects untrusted package identifiers and cursor shapes',()=>{
    for(const value of ['null','[]','{}',JSON.stringify({id:'other',after:null}),JSON.stringify({id,after:'../secret'})]) {
      expect(()=>parseUploadPackageLocation(value)).toThrow()
    }
    expect(parseUploadPackageLocation(JSON.stringify({id}))).toEqual({id,after:null})
  })
  it('quietly offers only stored HTTPS Frame links for completed files',()=>{
    const completed={...row(1,'complete'),frame_review_url:'https://f.io/receipt'}
    expect(JSON.stringify(uploadPackageModal({...page,approvals:[completed]}))).toContain('https://f.io/receipt')
    for(const url of ['javascript:alert(1)','https://f.io.evil.test/x','https://user:password@f.io/x','http://f.io/x']) {
      expect(JSON.stringify(uploadPackageModal({...page,approvals:[{...completed,frame_review_url:url}]}))).not.toContain('kit_delivery_package_share')
    }
    expect(JSON.stringify(uploadPackageModal({...page,approvals:[{...completed,state:'uploading'}]}))).not.toContain('kit_delivery_package_share')
  })
})
