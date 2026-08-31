/**
 * Slack typing-indicator wrapper.
 *
 * When Kit is registered as an Assistant in the Slack app config,
 * `assistant.threads.setStatus` shows native typing UI in DMs and threads.
 * Outside of assistant-enabled surfaces, the call no-ops (Slack returns
 * `assistant_not_supported` which we swallow).
 */

import type { App } from '@slack/bolt'

export async function setThinking(
  app: App,
  channelId: string,
  threadTs: string | undefined,
  status: string,
): Promise<void> {
  if (!threadTs) return // status API requires a thread context

  try {
    await app.client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    })
  } catch (err: any) {
    // `assistant_not_supported`, `not_in_channel`, etc. — non-fatal
    if (err?.data?.error !== 'assistant_not_supported') {
      console.warn('[Kit] setStatus failed:', err?.data?.error || err?.message)
    }
  }
}

export async function clearThinking(
  app: App,
  channelId: string,
  threadTs: string | undefined,
): Promise<void> {
  return setThinking(app, channelId, threadTs, '')
}
