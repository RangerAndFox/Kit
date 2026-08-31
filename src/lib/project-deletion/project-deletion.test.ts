import assert from 'node:assert/strict'
import test from 'node:test'
import { deletionConfirmationText, isDeleteProjectTrigger, PROJECT_DELETION_STEPS, type ProjectDeletionSnapshot } from './types'
import { runProjectDeletion, type ProjectDeletionStore } from './workflow'

const snapshot: ProjectDeletionSnapshot = {
  projectId: '11111111-1111-1111-1111-111111111111',
  workspaceId: '22222222-2222-2222-2222-222222222222',
  projectNumber: '9998',
  client: 'Internal',
  projectName: 'Delete test',
  canvasIds: ['F1'],
  hasSheetBinding: true,
  frameioProjectId: 'frame-1',
  retainedLinks: [],
}

function fakeStore(previous: Record<string, string> = {}) {
  const status: string[] = []
  const finishes: Array<{ step: string; state: string }> = []
  const store: ProjectDeletionStore = {
    getRequest: async () => ({
      id: 'request-1', workspace_id: snapshot.workspaceId, project_id: snapshot.projectId,
      requested_by_slack_user_id: 'U1', idempotency_key: 'view-1', status: 'awaiting_confirmation', project_snapshot: snapshot,
      error: null, started_at: null, completed_at: null, created_at: '', updated_at: '',
    }),
    setStatus: async (_id, state) => { status.push(state) },
    getStep: async (_id, step) => previous[step] ? { status: previous[step] } : null,
    startStep: async () => {},
    finishStep: async (_id, step, state) => { finishes.push({ step, state }) },
  }
  return { store, status, finishes }
}

test('delete-project trigger stays strict and confirmation is project-specific', () => {
  assert.equal(isDeleteProjectTrigger('delete project'), true)
  assert.equal(isDeleteProjectTrigger('/kit delete project'), true)
  assert.equal(isDeleteProjectTrigger('please delete the project because it is old'), false)
  assert.equal(deletionConfirmationText('2637'), 'DELETE 2637')
})

test('a provider failure prevents the final database commit but continues independent cleanup', async () => {
  const calls: string[] = []
  const { store, status } = fakeStore()
  const outcome = await runProjectDeletion('request-1', {
    run: async (step) => {
      calls.push(step)
      if (step === 'frameio') throw new Error('provider unavailable')
      return { ok: true }
    },
  }, store)
  assert.equal(outcome.status, 'partial')
  assert.equal(calls.includes('database'), false)
  assert.deepEqual(calls, PROJECT_DELETION_STEPS.filter((step) => step !== 'database'))
  assert.deepEqual(status, ['running', 'partial'])
})

test('retry skips completed steps, reruns failures, then deletes the database record last', async () => {
  const calls: string[] = []
  const completedBefore = Object.fromEntries(
    PROJECT_DELETION_STEPS.filter((step) => !['frameio', 'database'].includes(step)).map((step) => [step, 'complete']),
  )
  const { store, status } = fakeStore({ ...completedBefore, frameio: 'failed' })
  const outcome = await runProjectDeletion('request-1', {
    run: async (step) => { calls.push(step); return { ok: true } },
  }, store)
  assert.equal(outcome.status, 'complete')
  assert.deepEqual(calls, ['frameio', 'database'])
  assert.deepEqual(status, ['running', 'complete'])
})
