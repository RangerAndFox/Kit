import type { CheckResult } from './diff'

/** A timeout means the check is unknown, not that an upload failed. Cancel
 * supported I/O and always clear the timer; never let timed-out reads linger. */
export async function runHealthProbe(
  key: string,
  label: string,
  fn: (signal: AbortSignal) => Promise<string | void>,
  timeoutMs = 10_000,
): Promise<CheckResult> {
  const started = Date.now()
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
    const detail = await Promise.race([fn(controller.signal), deadline])
    return { key, label, ok: true, detail: detail || `${Date.now() - started}ms` }
  } catch (error) {
    return { key, label, ok: false, detail: String(error instanceof Error ? error.message : error).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}
