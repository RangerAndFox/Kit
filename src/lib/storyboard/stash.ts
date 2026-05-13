// @ts-nocheck
/**
 * In-process stash for storyboard intake.
 *
 * Slack's view.private_metadata is limited to ~3KB, so we can't round-trip
 * a full script through it. Instead, when we open the settings modal we
 * stash the script (or a file reference) keyed by a short UUID and put
 * only that key in private_metadata. The interaction handler looks it up
 * on submit.
 *
 * Entries TTL after 30 minutes so abandoned modals don't leak.
 */

import crypto from 'node:crypto'

export interface StoryboardIntake {
  /** Pasted script text (mutually exclusive with file). */
  script?: string
  /** Slack-hosted source file to download on submit. */
  file?: {
    id: string
    url_private: string
    name: string
    filetype?: string
    mimetype?: string
  }
  /** Filename-derived project name suggestion for the modal default. */
  suggestedName?: string
  /** Slack channel where the user invoked the flow (so we DM/post there). */
  channelId: string
  /** Triggering user ID. */
  userId: string
  /**
   * If the user invoked from inside a Slack Assistant thread (Agents & AI
   * Apps), this is the thread_ts. Progress messages + the summary card must
   * be threaded with this ts to appear inside the assistant view.
   */
  assistantThreadTs?: string
  /** When this entry was created (ms). */
  createdAt: number
}

const TTL_MS = 30 * 60 * 1000
const store = new Map<string, StoryboardIntake>()

function gc() {
  const now = Date.now()
  for (const [k, v] of store.entries()) {
    if (now - v.createdAt > TTL_MS) store.delete(k)
  }
}

export function stashIntake(intake: Omit<StoryboardIntake, 'createdAt'>): string {
  gc()
  const token = crypto.randomBytes(8).toString('hex')
  store.set(token, { ...intake, createdAt: Date.now() })
  return token
}

export function takeIntake(token: string): StoryboardIntake | null {
  gc()
  const entry = store.get(token)
  if (!entry) return null
  store.delete(token)
  return entry
}

export function peekIntake(token: string): StoryboardIntake | null {
  gc()
  return store.get(token) || null
}

/** Merge partial fields into an existing intake; used when later steps
 *  (like the button click) carry context we didn't have when stashing. */
export function updateIntake(
  token: string,
  patch: Partial<Omit<StoryboardIntake, 'createdAt'>>,
): void {
  const entry = store.get(token)
  if (!entry) return
  store.set(token, { ...entry, ...patch })
}
