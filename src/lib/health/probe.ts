import type { CheckResult } from './diff'
import { isTransientHealthError, retryHealthIo } from './retry'

/** A timeout means the check is unknown, not that an upload failed. Cancel
 * supported I/O and always clear the timer; never let timed-out reads linger. */
export async function runHealthProbe(
  key: string,
  label: string,
  fn: (signal: AbortSignal) => Promise<string | void>,
  timeoutMs = 10_000,
): Promise<CheckResult> {
  const started = Date.now()
  try {
    const detail = await retryHealthIo(() => probeAttempt(fn, timeoutMs))
    return { key, label, ok: true, detail: detail || `${Date.now() - started}ms` }
  } catch (error) {
    const unknown = isTransientHealthError(error)
    return { key, label, ok: false, ...(unknown ? { unknown: true } : {}),
      detail: unknown ? 'Health check unavailable after two attempts; current status unknown'
        : String(error instanceof Error ? error.message : error).slice(0, 300) }
  }
}

async function probeAttempt(fn: (signal: AbortSignal) => Promise<string | void>, timeoutMs: number): Promise<string | void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`health check timed out after ${timeoutMs}ms; current status unknown`)
        reject(error)
        controller.abort(error)
      }, timeoutMs)
    })
    return await Promise.race([fn(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
