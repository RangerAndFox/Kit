import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectCodeMatches } from './project-identity'
import { isOperationalProject, projectFilterFormula } from './project-filters'
import { resolveSyncableProjectIdByCode, __setStoreClientForTests } from './store'

test('studio codes match exact number/suffix, never partial names or adjacent numbers', () => {
  assert.equal(projectCodeMatches('2645-Microsoft', '2645'), true)
  assert.equal(projectCodeMatches('2630A_Internal', '2630a'), true)
  for (const code of ['26450', '2645A-Microsoft', 'X2645-Microsoft']) assert.equal(projectCodeMatches(code, '2645'), false)
  assert.equal(projectCodeMatches('2645-Microsoft', '2645-Other'), false)
})

test('target resolver limits identity matches to connected workbook bindings and rejects ambiguity', async () => {
  let projects = [{ id: 'one', project_code: '2645-Microsoft' }]
  const bound = [{ project_id: 'one' }]
  __setStoreClientForTests(() => ({ from(table: string) {
    const query = { select: () => query, eq: () => query, in: (_key: string, ids: string[]) => {
      assert.deepEqual(ids, bound.map(row => row.project_id)); return query
    }, then(resolve: (v: unknown) => void) { resolve({ data: table === 'projects' ? projects : bound, error: null }) } }
    return query
  } }))
  try {
    assert.equal(await resolveSyncableProjectIdByCode('sheet', '2645'), 'one')
    bound.push({ project_id: 'two' }); projects = [...projects, { id: 'two', project_code: '2645_Another' }]
    assert.equal(await resolveSyncableProjectIdByCode('sheet', '2645'), null)
    assert.equal(await resolveSyncableProjectIdByCode('sheet', '26450'), null)
  } finally { __setStoreClientForTests(null) }
})

test('operational filters hide historical/test choices without an arbitrary age cutoff', () => {
  assert.equal(isOperationalProject('2627', 'On Hold'), true)
  assert.equal(isOperationalProject('2630B', 'Needs Review'), true)
  for (const lifecycle of ['Archived', 'Completed', '', 'Retired']) assert.equal(isOperationalProject('2611', lifecycle), false)
  for (const code of ['9998', '9876', 'placeholder', '']) assert.equal(isOperationalProject(code, 'Active'), false)
  assert.match(projectFilterFormula(), /UNIQUE\(FILTER/)
  assert.match(projectFilterFormula(), /REGEXEXTRACT/)
  assert.match(projectFilterFormula(), /active\|on hold\|needs review/)
  assert.doesNotMatch(projectFilterFormula(true), /active\|on hold\|needs review/)
})
