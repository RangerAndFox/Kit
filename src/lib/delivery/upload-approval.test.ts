import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvedRenameMatches, buildUploadRenameIntent, suggestedUploadName, validateUploadName, distinctUploadName, uploadReviewers, approvalMatches, type UploadApproval } from './upload-approval'

test('client-facing suggestion strips internal prefix and only infers explicit phases', () => {
  assert.equal(suggestedUploadName('Microsoft', '2643_CRM Skills', '092826/my_edit_V2.mov'), 'R&F_Microsoft_CRM_Skills_edit_V2.mov')
  assert.equal(suggestedUploadName('Microsoft', 'CRM', '092826/video.mov'), 'R&F_Microsoft_CRM.mov')
  assert.equal(validateUploadName('R&F_Microsoft_CRM.mov','video.mov'), null)
  assert.equal(suggestedUploadName('Microsoft', 'Cloud PC', '102326/R&F_Microsoft_Cloud_PC_Edit_V3.mp4'), 'R&F_Microsoft_Cloud_PC_Edit_V3.mp4')
  assert.equal(validateUploadName('R&F_Microsoft_CRM_Anim_R1.mov','video.mov'), null)
})
test('names cannot traverse, change media extension, or expose project numbers', () => {
  for (const name of ['R&F_A.mov','R&F_A__B.mov','R&F_A_B_../thing.mov','R&F_A_B_2643_R1.mov','R&F_A_B_R1.exe','R&F_A_B_R1\n.mov']) assert.ok(validateUploadName(name,'original.mov'),name)
  assert.equal(distinctUploadName('R&F_A_B_Edit_V2.mov',['R&F_A_B_Edit_V2_02.MOV']), 'R&F_A_B_Edit_V2_03.mov')
})
test('producer and CD share recipients without duplicates or arbitrary channel IDs', () => {
  assert.deepEqual(uploadReviewers({project_manager_slack_id:'U123',external_ids:{creative_director_slack_id:'U123'}}), ['U123'])
  assert.deepEqual(uploadReviewers({project_manager_slack_id:'C123',external_ids:{creative_director_slack_id:'U456'}}), ['U456'])
})
test('approval requires exact project, source revision and decision generation', () => {
  const row = {project_id:'p',source_file_id:'id:f',source_rev:'rev1',approval_version:1,state:'approved'} as UploadApproval
  const source = {path:'/x',name:'x.mov',subfolder:'02_Delivery',safeName:'p',year:'2026',dropboxId:'id:f',rev:'rev1',approvalVersion:1}
  assert.equal(approvalMatches(row,source,'p'),true)
  assert.equal(approvalMatches(row,{...source,rev:'rev2'},'p'),false)
  assert.equal(approvalMatches(row,{...source,approvalVersion:2},'p'),false)
  assert.equal(approvalMatches({...row,state:'skipped'},source,'p'),false)
  assert.equal(approvalMatches(row,source,'other'),false)
})

test('rename intent binds unchanged contents to an approved destination without replacing the source revision', () => {
  const row = { source_file_id:'id:f',source_rev:'abcdef12345',source_size:12,source_path:'/project/video.mov',
    approved_by:'UPRODUCER',approval_version:1,approved_name:'R&F_Client_Project.mov',source_payload:{} } as UploadApproval
  const before = {id:'id:f',rev:'abcdef12345',size:12,path_display:'/project/video.mov',content_hash:'a'.repeat(64)}
  const intent = buildUploadRenameIntent(row,before)
  const recorded = {...row,source_payload:{rename_intent:intent}}
  const after = {...before,rev:'abcdef54321',path_display:'/project/R&F_Client_Project.mov'}
  assert.equal(intent.source_rev,row.source_rev)
  assert.equal(approvedRenameMatches(recorded,after),true)
  assert.equal(approvedRenameMatches(row,after),false)
  for (const invalid of [
    {...after,id:'id:replacement'}, {...after,size:13}, {...after,content_hash:'b'.repeat(64)},
    {...after,content_hash:undefined}, {...after,path_display:'/elsewhere/R&F_Client_Project.mov'},
    {...after,path_display:'/project/other.mov'}, {...after,rev:''},
  ]) assert.equal(approvedRenameMatches(recorded,invalid),false)
  assert.equal(approvedRenameMatches({...recorded,approved_by:'UOTHER'},after),false)
  assert.equal(approvedRenameMatches({...recorded,approval_version:0},after),false)
  assert.throws(()=>buildUploadRenameIntent(row,{...before,content_hash:undefined}))
  assert.throws(()=>buildUploadRenameIntent(row,{...before,rev:'abcdef54321'}))
})

test('a collision resolution by the same approver can journal a second rename, but not changed media', () => {
  const row = { source_file_id:'id:f',source_rev:'abcdef12345',source_size:12,source_path:'/project/video.mov',
    approved_by:'UPRODUCER',approval_version:1,approved_name:'R&F_Client_Project.mov',source_payload:{} } as UploadApproval
  const before={id:'id:f',rev:row.source_rev,size:12,path_display:row.source_path,content_hash:'a'.repeat(64)}
  const recorded={...row,source_payload:{rename_intent:buildUploadRenameIntent(row,before)},approval_version:2,approved_name:'R&F_Client_Project_02.mov'}
  const after={...before,rev:'abcdef54321',path_display:'/project/R&F_Client_Project.mov'}
  assert.equal(buildUploadRenameIntent(recorded,after).target_path,'/project/r&f_client_project_02.mov')
  assert.throws(()=>buildUploadRenameIntent(recorded,{...after,content_hash:'b'.repeat(64)}))
})
