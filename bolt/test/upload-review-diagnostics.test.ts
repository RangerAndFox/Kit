import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeUploadInteraction, uploadReviewDiagnostic } from '../src/watchers/upload-review-diagnostics'

afterEach(() => vi.restoreAllMocks())
describe('safe upload diagnostics', () => {
  it('records known codes and IDs, never raw payloads or error messages', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    uploadReviewDiagnostic('open_form_failed', { action: 'kit_frame_upload_review', actor: 'U123',
      request: '769d47ea-78ea-4bba-a13f-5f504943ebfa',
      error: { message: 'SECRET', data: { error: 'expired_trigger_id', trigger_id: 'SECRET' } } })
    expect(JSON.stringify(log.mock.calls)).toContain('expired_trigger_id')
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET')
    uploadReviewDiagnostic('failure', { request: 'SECRET', actor: 'SECRET', action: 'SECRET', error: { data: { error: 'SECRET' } } })
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET')
  })
  it('observes only upload clicks without acknowledging or executing them', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    observeUploadInteraction({ body: { actions: [{ action_id: 'unrelated' }] } })
    expect(log).not.toHaveBeenCalled()
    observeUploadInteraction({ body: { actions: [{ action_id: 'kit_frame_upload_review' }], user: { id: 'U123' } } })
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).toContain('socket_received')
  })
})
