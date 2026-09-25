import assert from 'node:assert/strict'
import { test } from 'node:test'
import { teamProjectSummary, composeProjectSummaryText, type ProjectSummaryInput } from './project-summary'
import { readBoundedPages } from './bounded-pages'

test('team summary excludes every financial/freeform source and its metadata', () => {
  const project: ProjectSummaryInput = {
    id: 'project', workspace_id: 'workspace', name: 'Launch', client: 'Client', project_code: '2642',
    project_type: 'Video', status: 'active', start_date: '2026-09-01', target_delivery: '2026-09-30',
    budget_total: 99991, budget_spent: 88882, brief_summary: 'PRIVATE-BRIEF', sow_summary: 'PRIVATE-SOW',
    external_links: { confidential: 'https://example.com/private' },
    project_manager_slack_id: 'UPRODUCER', harvest_project_id: 77773,
  }
  const safe = teamProjectSummary(project)
  assert.equal(safe.visibilityTier, 'team')
  assert.equal(safe.docType, 'project_summary_safe')
  assert.match(safe.content, /Target delivery: 2026-09-30/)
  assert.match(safe.content, /UPRODUCER/)
  assert.doesNotMatch(JSON.stringify(safe), /99991|88882|77773|PRIVATE|example.com|budget|sow|brief/i)
  assert.match(composeProjectSummaryText(project).content, /99991/)
})

test('summary metadata pagination reads past the first provider page and fails on errors or caps', async () => {
  const ranges: number[] = []
  const result = await readBoundedPages(async from => {
    ranges.push(from)
    return { data: Array.from({ length: from === 0 ? 500 : 2 }, (_, i) => from + i), error: null }
  })
  assert.equal(result.length, 502)
  assert.deepEqual(ranges, [0, 500])
  await assert.rejects(readBoundedPages(async () => ({ data: null, error: new Error('offline') })), /lookup failed/)
  await assert.rejects(readBoundedPages(async () => ({ data: Array(500).fill(1), error: null })), /10,000/)
})
