const actions = new Set(['kit_frame_upload_review', 'kit_frame_upload_skip', 'kit_frame_collision_review'])
const safeErrors = new Set(['expired_trigger_id', 'invalid_trigger_id', 'trigger_exchanged', 'invalid_arguments',
  'invalid_auth', 'token_revoked', 'account_inactive', 'missing_scope', 'not_allowed_token_type',
  'ratelimited', 'internal_error', 'service_unavailable', 'view_not_found', 'hash_conflict'])

/** Never log raw Slack bodies, trigger IDs, filenames, tokens, or error messages. */
export function uploadReviewDiagnostic(stage: string, input: { action?: unknown; request?: unknown; actor?: unknown; error?: unknown }) {
  const error = input.error as { code?: unknown; data?: { error?: unknown } } | undefined
  const providerCode = error?.data?.error
  console.info('[upload-review]', JSON.stringify({
    stage,
    action: typeof input.action === 'string' && actions.has(input.action) ? input.action : undefined,
    request: typeof input.request === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.request) ? input.request : undefined,
    actor: typeof input.actor === 'string' && /^[UW][A-Z0-9]+$/.test(input.actor) ? input.actor : undefined,
    error: input.error === undefined ? undefined : typeof providerCode === 'string' && safeErrors.has(providerCode)
      ? providerCode : 'review_failed',
  }))
}

/** Passive transport observer: do not ack or handle the event a second time. */
export function observeUploadInteraction(event: { body?: { actions?: Array<{ action_id?: string; value?: string }>; user?: { id?: string } } }) {
  const action = event.body?.actions?.[0]
  if (action?.action_id && actions.has(action.action_id)) uploadReviewDiagnostic('socket_received', {
    action: action.action_id, request: action.value, actor: event.body?.user?.id,
  })
}
