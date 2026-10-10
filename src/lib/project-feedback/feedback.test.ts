import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { assetSources, parseSource, renderFeedback, digest } from './model'
import { publishSection, type SlackCall } from './canvas'
import { syncFeedbackRow, type FeedbackRow } from './sync'
import { readFeedback, type ProviderDeps } from './providers'
import { readDocxComments } from './docx'

const source = parseSource('https://figma.com/proto/FILE123/Deck?node-id=1-2', 'Deck')!
const snapshot = { title: 'Deck', comments: [{ id: '1', author: 'Ally', text: 'Change this', date: '2026-10-09T22:00:00Z', resolved: false }] }
const row: FeedbackRow = { id: 'one', project_id: 'project', source, snapshot, active: true, heading_hash: null, body_hash: null }
test('only explicit active team asset types are imported; canonical files deduplicate', () => {
  const entry = { 'Link Type':'Figma', URL:source.url }
  assert.equal(assetSources([entry,{...entry,URL:'https://figma.com/design/FILE123/Other?node-id=4-1'}]).length,1)
  for (const link of [{...entry,Active:'FALSE'},{...entry,'Link Type':'Budget'},{...entry,URL:'https://figma.com.evil.test/design/FILE123'}, {...entry,URL:'https://user:secret@figma.com/design/FILE123'}]) assert.equal(assetSources([link]).length,0)
  assert.equal(parseSource('https://drive.google.com/open?id=abc_12','Script')?.fileId,'abc_12')
  assert.equal(parseSource('http://127.0.0.1/file','Bad'),null)
})
test('H3, source labels, Pacific dates, replies and untrusted prose render safely', () => {
  const rendered = renderFeedback(source,{...snapshot,comments:[...snapshot.comments,{ id:'2',parentId:'1',author:'Ted',text:'<!channel> **Approve** | x\n# Fake heading',date:'2026-10-10T01:00:00Z',resolved:true }]})
  assert.match(rendered.heading,/^### 🎨 Figma/)
  assert.match(rendered.table,/Oct 9, 2026, 3:00 PM PDT/)
  assert.match(rendered.table,/↳ Reply/)
  assert.doesNotMatch(rendered.table,/<!channel>|\n# Fake/)
  assert.match(rendered.table,/✅ Resolved/)
})
test('only directly linked documents are read, not general project folders; previews stay bounded', () => {
  assert.equal(assetSources([{'Link Type':'Dropbox',URL:'https://www.dropbox.com/scl/fo/folder/name?rlkey=secret'}]).length,0)
  assert.equal(assetSources([{'Link Type':'Script',URL:'https://www.dropbox.com/scl/fo/folder/name?rlkey=secret'}]).length,1)
  const rendered=renderFeedback(source,{title:'Deck',comments:Array.from({length:100},(_,i)=>({...snapshot.comments[0],id:String(i),text:'A'.repeat(20_000)}))})
  assert.ok(Buffer.byteLength(rendered.table)<30_000)
  assert.match(rendered.table,/continued in original/)
  assert.match(rendered.table,/additional comments/)
})
test('publication reconciles a previously inserted section and never replaces the entire canvas', async () => {
  const calls: Array<{method:string;data:Record<string,unknown>}> = []
  const slack: SlackCall = async (method,data) => { calls.push({method,data}); return method.endsWith('lookup') ? {sections:[{id:'fresh'}]} : {} }
  await publishSection({canvasId:'F1',marker:'key',type:'table',markdown:'table',changed:true,assertOwned:async()=>{}},slack)
  assert.deepEqual(calls[1].data.changes,[{operation:'replace',section_id:'fresh',document_content:{type:'markdown',markdown:'table'}}])
  calls.length=0
  await publishSection({canvasId:'F1',marker:'key',type:'table',markdown:'table',changed:false,assertOwned:async()=>{}},slack)
  assert.equal(calls.length,1)
})
test('missing sections are repaired, but ambiguous markers and lost ownership fail closed', async () => {
  let writes=0
  const input={canvasId:'F1',marker:'key',type:'h3' as const,markdown:'heading',changed:false,assertOwned:async()=>{}}
  await publishSection(input,async(method)=>{ if(method.endsWith('edit'))writes++;return{sections:[]} })
  assert.equal(writes,1)
  await assert.rejects(publishSection(input,async()=>({sections:[{id:'a'},{id:'b'}]})),/ambiguous/)
  await assert.rejects(publishSection({...input,assertOwned:async()=>{throw Error('lost')}},async()=>({sections:[]})),/lost/)
})
test('source outages preserve previous comments, label stale data, and checkpoint only after both sections', async () => {
  const events:string[]=[]
  await syncFeedbackRow(row,'F1',{read:async()=>{throw Error('secret provider body')},assertOwned:async()=>{},publish:async i=>{events.push(i.markdown)},finish:async(s,h,b,e)=>{
    assert.deepEqual(s,snapshot); assert.ok(h&&b); assert.equal(e,'feedback_read_failed'); events.push('finish')
  }})
  assert.match(events[1],/Change this/); assert.match(events[1],/may be stale/); assert.doesNotMatch(events[1],/secret provider body/)
  assert.equal(events[2],'finish')
})
test('Slack timeout never checkpoints the new publication hash; retries can reconcile',async()=>{
  await assert.rejects(syncFeedbackRow(row,'F1',{read:async()=>snapshot,assertOwned:async()=>{},publish:async()=>{throw Error('timeout')},finish:async(s,h,b,e)=>{
    assert.equal(h,null);assert.equal(b,null);assert.equal(e,'feedback_canvas_sync_failed')
  }}),/feedback_canvas_sync_failed/)
})
test('removed assets do not read provider content and stop publishing their comments',async()=>{
  await syncFeedbackRow({...row,active:false},'F1',{read:async()=>{throw Error('must not run')},assertOwned:async()=>{},publish:async i=>{
    assert.doesNotMatch(i.markdown,/Change this/)
  },finish:async(s)=>{assert.equal(s,null)}})
})
test('repeated identical snapshot is unchanged and credential absence makes no network call',async()=>{
  const rendered=renderFeedback(source,snapshot)
  await syncFeedbackRow({...row,heading_hash:digest(rendered.heading),body_hash:digest(rendered.table)},'F1',{
    read:async()=>snapshot,assertOwned:async()=>{},publish:async i=>assert.equal(i.changed,false),finish:async()=>{},
  })
  await assert.rejects(readFeedback(source,{fetch:async()=>{throw Error('must not call')},figmaToken:()=>undefined,googleToken:async()=>'',dropboxToken:async()=>''}),/figma_connection_required/)
})
test('Figma comments preserve source IDs, threads and resolution; pasted URLs are not fetched',async()=>{
  const deps:ProviderDeps={fetch:async(url,init)=>{
    assert.equal(url,'https://api.figma.com/v1/files/FILE123/comments');assert.equal(init?.redirect,'error')
    return Response.json({comments:[{id:'1',message:'note',created_at:'2026-10-09',resolved_at:'2026-10-10',user:{handle:'Ally'}},{id:'2',parent_id:'1',message:'reply',created_at:'2026-10-10'}]})
  },figmaToken:()=> 'test',googleToken:async()=>'',dropboxToken:async()=>''}
  const r=await readFeedback(source,deps)
  assert.equal(r.comments[0].resolved,true); assert.equal(r.comments[1].parentId,'1')
})
test('Drive consumes every comment page and replies; 403 is not an empty success',async()=>{
  let n=0
  const deps:ProviderDeps={figmaToken:()=>'',googleToken:async()=> 'test',dropboxToken:async()=>'',fetch:async()=>{
    n++;return Response.json(n===1?{name:'Script',mimeType:'application/vnd.google-apps.document'}:n===2?{comments:[{id:'1',content:'one',replies:[{id:'r',content:'reply'}]}],nextPageToken:'next'}:{comments:[{id:'2',content:'two',resolved:true}]})
  }}
  const r=await readFeedback(parseSource('https://docs.google.com/document/d/DOC123/edit','Script')!,deps)
  assert.equal(n,3);assert.equal(r.comments.length,3);assert.equal(r.comments[1].parentId,'drive:1')
  await assert.rejects(readFeedback(source,{...deps,figmaToken:()=> 'test',fetch:async()=>new Response('',{status:403})}),/provider_http_403/)
})
test('Dropbox reads saved Word comments through the fixed content API, never a pasted URL',async()=>{
  const zip=new JSZip()
  zip.file('word/comments.xml','<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1"><w:p><w:r><w:t>Dropbox Word note</w:t></w:r></w:p></w:comment></w:comments>')
  const bytes=await zip.generateAsync({type:'uint8array'})
  const s=parseSource('https://www.dropbox.com/scl/fi/abc/Script.docx?rlkey=key&dl=0','Script')!
  const calls:string[]=[]
  const deps:ProviderDeps={figmaToken:()=>'',googleToken:async()=>'',dropboxToken:async()=>'test',fetch:async(url,init)=>{
    calls.push(String(url)); assert.equal(init?.redirect,'error')
    return calls.length===1?Response.json({'.tag':'file',name:'Script.docx',size:bytes.length}):new Response(new Uint8Array(bytes).buffer)
  }}
  const r=await readFeedback(s,deps)
  assert.equal(r.comments[0].text,'Dropbox Word note')
  assert.deepEqual(calls,['https://api.dropboxapi.com/2/sharing/get_shared_link_metadata','https://content.dropboxapi.com/2/sharing/get_shared_link_file'])
  await assert.rejects(readFeedback(s,{...deps,fetch:async()=>Response.json({'.tag':'folder',name:'Scripts'})}),/direct_docx_link_required/)
  await assert.rejects(readFeedback(source,{...deps,figmaToken:()=>'test',fetch:async()=>new Response('',{status:429,headers:{'Retry-After':'86400'}})}),e=>typeof e==='object'&&e!==null&&'retryAfterSeconds' in e&&e.retryAfterSeconds===86400)
})
test('Word parses namespace-aware comments, replies, resolution and refuses entity declarations',async()=>{
  const zip=new JSZip()
  zip.file('word/comments.xml','<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:comment w:id="1" w:author="Ally" w:date="2026-10-09"><w:p w14:paraId="P1"><w:r><w:t>Fix &amp; review</w:t></w:r></w:p></w:comment><w:comment w:id="2" w:author="Ted"><w:p w14:paraId="P2"><w:r><w:t>Done</w:t></w:r></w:p></w:comment></w:comments>')
  zip.file('word/commentsExtended.xml','<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="P1" w15:done="1"/><w15:commentEx w15:paraId="P2" w15:paraIdParent="P1"/></w15:commentsEx>')
  const result=await readDocxComments(await zip.generateAsync({type:'nodebuffer'}))
  assert.equal(result[0].text,'Fix & review');assert.equal(result[0].resolved,true);assert.equal(result[1].parentId,'word:1')
  zip.remove('word/commentsExtended.xml')
  zip.file('word/comments.xml','<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Ted"><w:p><w:r><w:t>Legacy comment</w:t></w:r></w:p></w:comment></w:comments>')
  const legacy=await readDocxComments(await zip.generateAsync({type:'nodebuffer'}))
  assert.equal(legacy[0].parentId,undefined);assert.equal(legacy[0].resolved,null)
  assert.match(renderFeedback(source,{title:'Legacy',comments:legacy}).table,/Legacy comment/)
  zip.file('word/comments.xml','<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc/>')
  await assert.rejects(readDocxComments(await zip.generateAsync({type:'nodebuffer'})),/unsafe_document_xml/)
})
