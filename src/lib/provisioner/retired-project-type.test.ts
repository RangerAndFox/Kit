import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Bolt's orchestration boundary has no isolated I/O harness. Guard its write
// sites as well as the behavioral modal/diff/Sheet tests, including recovery
// of persisted submissions that can still contain a historical projectType.
test('Bolt does not extract, fan out, or persist the retired Project Type', () => {
  const source = readFileSync(new URL('../../../bolt/src/handlers/interactions.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /values\.project_type/)
  assert.doesNotMatch(source, /project_type:\s*form\.projectType/)
  assert.doesNotMatch(source, /patch\.project_type\s*=/)
  assert.doesNotMatch(source, /projectType:\s*(?:form|f)\.projectType/)
  assert.doesNotMatch(source, /ownedFields\.projectType\s*=/)
})
