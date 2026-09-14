import {it} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext,Script} from 'node:vm'
const source=readFileSync(new URL('./project-control-sheet-edit.gs',import.meta.url),'utf8')
function context(){
 const ss={createDeveloperMetadataFinder:()=>({withKey:()=>({find:()=>[{getValue:()=>JSON.stringify({projectNumber:'2637',person:'Alex Example',lastWorkingDate:'2026-09-13'})}]})}),getSheetByName:()=>({getRange:()=>({getDisplayValues:()=>[['Alex Example'],['Other Artist']]})})}
 const c={SpreadsheetApp:{getActive:()=>ss}} as Record<string,unknown>;runInNewContext(source,c);return c
}
it('form excludes an offboarded person only for that project',()=>{
 const c=context();const people=c.kitAssignablePeople as (project:string)=>string[]
 assert.deepEqual(Array.from(people('2637')),['Other Artist']);assert.deepEqual(Array.from(people('2638')),['Alex Example','Other Artist'])
})
it('assignment form emits valid browser code and a locked-down person picker',()=>{
 const c=context();const build=c.buildKitAddRowHtml_ as (sheet:string,fields:unknown[],note:string)=>string
 const html=build('Daily Assignments',[{header:'Project ID',options:['2637']},{header:'Person',options:[]}],'')
 assert.match(html,/<select data-header="Person">/);assert.match(html,/kitAssignablePeople/)
 const script=html.match(/<script>([\s\S]*)<\/script>/)?.[1];assert.ok(script);assert.doesNotThrow(()=>new Script(script))
})
