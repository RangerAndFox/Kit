export const DEFAULT_TRANSCRIPT_APPROVAL_PREFIX = '[KIT]'

export function transcriptApprovalPrefix(env: Record<string, string | undefined> = process.env): string {
  return (env.TRANSCRIPT_APPROVAL_PREFIX || DEFAULT_TRANSCRIPT_APPROVAL_PREFIX).trim().toLowerCase()
}

/** Recording-level purpose signal required before transcript content is fetched. */
export function isTranscriptApprovedForIngest(
  name: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const prefix = transcriptApprovalPrefix(env)
  return Boolean(prefix && (name || '').trim().toLowerCase().startsWith(prefix))
}
