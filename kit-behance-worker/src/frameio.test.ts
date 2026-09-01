import assert from 'node:assert/strict'
import test from 'node:test'
import type { FrameioProjectDeletionJob } from './types.js'

const job: FrameioProjectDeletionJob = {
  id: 'job-1',
  project_id: 'kit-1',
  workspace_id: 'workspace-1',
  frameio_project_id: '67fe1867-0053-4150-8d46-472e2bdbd443',
  frameio_project_name: '2697_Internal_Test [kit:kit-1]',
  frameio_project_url: 'https://next.frame.io/project/67fe1867-0053-4150-8d46-472e2bdbd443',
  status: 'claimed', claimed_by: 'worker-1', claimed_at: '', heartbeat_at: '', attempt: 1, error: null,
}

test('Frame.io browser deletion accepts only an exact safe provider URL and id', async () => {
  process.env.KIT_STUDIO_WORKER_SECRET ||= 'test-secret-that-is-at-least-32-characters-long'
  process.env.DROPBOX_SYNC_PATH ||= '/private/tmp'
  const { validateFrameioDeletionJob } = await import('./frameio.js')
  assert.doesNotThrow(() => validateFrameioDeletionJob(job))
  assert.throws(() => validateFrameioDeletionJob({ ...job, frameio_project_url: 'https://example.com/project/67fe1867-0053-4150-8d46-472e2bdbd443' }), /unsafe project URL/i)
  assert.throws(() => validateFrameioDeletionJob({ ...job, frameio_project_id: 'not-an-id' }), /invalid project id/i)
})
