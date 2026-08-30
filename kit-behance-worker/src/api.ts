import { config } from './config.js'

export async function workerRequest<T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(config.workerApiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.workerApiSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, workerId: config.workerId, displayName: config.displayName, ...payload }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.ok) throw new Error(`Kit worker API ${action} failed: ${body.error || response.status}`)
  return body as T
}
