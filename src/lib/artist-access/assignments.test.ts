import {it} from 'node:test'
import assert from 'node:assert/strict'
import {projectAssignmentView,parseExclusion} from './assignments'
const exclusion={engagementId:'e',projectNumber:'2637',person:'Alex Example',lastWorkingDate:'2026-09-13'}
it('keeps historical assignments and other projects while flagging future and undated rows',()=>{
 const rows=['2026-09-12','9/13/2026','2026-09-14',''].map(Date=>({'Project ID':'2637',Person:' alex  example ',Date,'Daily Assignment':'Animation'}))
 rows.push({'Project ID':'2638',Person:'Alex Example',Date:'2026-09-15','Daily Assignment':'Design'})
 const original=structuredClone(rows);const result=projectAssignmentView(rows,[exclusion])
 assert.deepEqual(result.slice(0,2),rows.slice(0,2));assert.deepEqual(result[4],rows[4]);assert.deepEqual(rows,original)
 for(const row of result.slice(2,4)){assert.equal(row.Person,'Unassigned');assert.match(row['Daily Assignment'],/Needs reassignment/)}
})
it('invalid access metadata fails closed',()=>{assert.throws(()=>parseExclusion('{"person":"Alex"}'));assert.deepEqual(parseExclusion(JSON.stringify(exclusion)),exclusion)})
