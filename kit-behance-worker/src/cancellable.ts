export async function runCancellable<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController()
  const work = task(controller.signal).then((value) => ({ kind: 'value' as const, value }))
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  const outcome = await Promise.race([work, timeout])
  if (timer) clearTimeout(timer)
  if (outcome.kind === 'timeout') {
    controller.abort()
    await work.catch(() => {})
    throw new Error(timeoutMessage)
  }
  return outcome.value
}
