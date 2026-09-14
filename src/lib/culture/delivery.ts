export interface DeliveryPorts {
  prepareAndPost(beforeSend: () => Promise<void>): Promise<{ posted: boolean; ts?: string }>
  beginSend(): Promise<boolean>
  finish(status: 'posted' | 'failed' | 'review', ts?: string): Promise<void>
}
/** Failure before sending is retryable. An ambiguous send is NEVER automatically resent. */
export async function deliverCulture(ports: DeliveryPorts): Promise<boolean> {
  let sending = false
  try {
    const result = await ports.prepareAndPost(async () => {
      if (!await ports.beginSend()) throw new Error('Culture configuration changed before sending.')
      sending = true
    })
    if (!sending || !result.posted || !result.ts) throw new Error('Meme delivery was not acknowledged.')
    await ports.finish('posted', result.ts)
    return true
  } catch {
    await ports.finish(sending ? 'review' : 'failed')
    return false
  }
}
