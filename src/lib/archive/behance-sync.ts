/** Keep a failed Slack update retryable; acknowledging a version is the LAST step. */
export async function deliverBehanceUpdate<T>(steps: {
  prepare: () => Promise<T>
  deliver: (prepared: T) => Promise<void>
  acknowledge: () => Promise<void>
}): Promise<void> {
  const prepared = await steps.prepare()
  await steps.deliver(prepared)
  await steps.acknowledge()
}
