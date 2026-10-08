/** Retry transport failures, never a real job failure or an authorization error. */
export function isTransientHealthError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  // Stored job failures can themselves contain "timeout". They are confirmed
  // actionable outcomes, not a failure of this live read, and must stay red.
  if (/requires manual review|unconfirmed Slack outcome|upload failed|not configured|unauthorized|forbidden/i.test(message)) return false
  return /abort|timeout|timed out|fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|\b(?:429|502|503|504)\b/i.test(message)
}

export async function retryHealthIo<T>(read: () => Promise<T>,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250))): Promise<T> {
  try { return await read() } catch (error) {
    if (!isTransientHealthError(error)) throw error
    await pause()
    return read()
  }
}
