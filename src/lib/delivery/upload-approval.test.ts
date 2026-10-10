import assert from 'node:assert/strict'
import { test } from 'node:test'
import { suggestedUploadName, validateUploadName, distinctUploadName, uploadReviewers, approvalMatches, type UploadApproval } from './upload-approval'

test('client-facing suggestion strips internal prefix and only infers explicit phases', () => {
  assert.equal(suggestedUploadName('Microsoft', '2643_CRM Skills', '092826/my_edit_V2.mov'), 'R&F_Microsoft_CRM_Skills_edit_V2.mov')
  assert.equal(suggestedUploadName('Microsoft', 'CRM', '092826/video.mov'), 'R&F_Microsoft_CRM_Phase_Version.mov')
  assert.ok(validateUploadName('R&F_Microsoft_CRM_Phase_Version.mov','video.mov'))
  assert.equal(validateUploadName('R&F_Microsoft_CRM_Anim_R1.mov','video.mov'), null)
})
test('names cannot traverse, change media extension, or expose project numbers', () => {
  for (const name of ['R&F_A_B_../thing.mov','R&F_A_B_2643_R1.mov','R&F_A_B_R1.exe','R&F_A_B_R1\n.mov']) assert.ok(validateUploadName(name,'original.mov'),name)
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
