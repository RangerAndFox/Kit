// @ts-nocheck
/**
 * In-memory "pending onboarding" state per (channel, user).
 *
 * Set after Kit asks for missing info, so the user's next message in
 * that channel — even without @Kit and without the "onboard" keyword —
 * gets routed back to the onboarding parser. State combines what we
 * already extracted with what arrives next.
 *
 * 15-minute TTL. Lost on redeploy — that's fine; user just re-prompts.
 */

export interface PendingOnboard {
  artistName: string | null
  artistEmail: string | null
  projectQuery: string | null
  createdAt: number
}

const TTL_MS = 15 * 60 * 1000
const pending = new Map<string, PendingOnboard>()

function key(channelId: string, userId: string): string {
  return `${channelId}:${userId}`
}

function isExpired(p: PendingOnboard): boolean {
  return Date.now() - p.createdAt > TTL_MS
}

export function setPendingOnboarding(
  channelId: string,
  userId: string,
  partial: Omit<PendingOnboard, 'createdAt'>,
): void {
  pending.set(key(channelId, userId), { ...partial, createdAt: Date.now() })
}

export function getPendingOnboarding(
  channelId: string,
  userId: string,
): PendingOnboard | null {
  const p = pending.get(key(channelId, userId))
  if (!p) return null
  if (isExpired(p)) {
    pending.delete(key(channelId, userId))
    return null
  }
  return p
}

export function clearPendingOnboarding(channelId: string, userId: string): void {
  pending.delete(key(channelId, userId))
}
