import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderNames, folderSuggestedBase, uploadDate, uploadFolderPath, folderDropboxUrl, type FolderContext } from './upload-folder'
import type { UploadApproval } from './upload-approval'
const root='/production/2026/2646_Microsoft_Foundry/09_Outgoing/02_Delivery/111726'
const context=(names:string[]):FolderContext=>({folder:{folder_path:uploadFolderPath(`${root}/Web/video.mp4`)} as FolderContext['folder'],files:names.map((name,i)=>({id:String(i),state:'awaiting',source_path:`${root}/${name}`} as UploadApproval)),slots:[],dirty:[],legacy:[]})
test('folder key groups nested deliverables but separates projects, dates and outgoing kinds',()=>{
  assert.equal(uploadFolderPath(`${root}/Web/02_Accessibility/c.vtt`),root.toLowerCase())
  assert.equal(uploadFolderPath(`${root}/Broadcast/01_Video/edit.mov`),root.toLowerCase())
  assert.notEqual(uploadFolderPath(`${root}b/edit.mov`),root.toLowerCase())
  assert.equal(uploadFolderPath(root.replace('/111726','')+'/edit.mp4'),root.replace('/111726','').toLowerCase())
  assert.throws(()=>uploadFolderPath('/wrong/file.mp4'))
  assert.ok(folderDropboxUrl(root).includes('Ranger%20%26%20Fox'))
})
test('Delivery uses actual formats and distinct numbers, preserving extensions and subfolders',()=>{
  const c=context(['Web/a.mp4','Web/b.mp4','Web/c.vtt','Broadcast/a.mov'])
  const names=folderNames(c,'R&F_Microsoft_Foundry','111726')
  assert.equal(new Set(names.map(n=>n.name)).size,4)
  assert.ok(names.some(n=>n.name==='R&F_Microsoft_Foundry_MP4_111726_02.mp4'))
  assert.ok(names.some(n=>n.name==='R&F_Microsoft_Foundry_VTT_111726.vtt'))
  assert.throws(()=>folderNames(c,'../../bad','111726'))
})
test('Client Progress retains an editable phase prefix; no phase or render checkbox is required',()=>{
  const c=context(['edit.mp4']);c.folder.folder_path=c.folder.folder_path.replace('02_delivery','01_client progress')
  assert.equal(folderNames(c,'R&F_Microsoft_Foundry_Edit_V6','111726')[0].name,'R&F_Microsoft_Foundry_Edit_V6_111726.mp4')
  assert.equal(folderNames(c,'R&F_Microsoft_Foundry','111726').length,1)
  assert.match(folderSuggestedBase('Microsoft','Foundry',c.folder.folder_path.replace('111726','111726_edit_v6')),/edit_v6$/)
  assert.equal(uploadDate(new Date('2026-11-18T01:00:00Z')),'111726')
})
