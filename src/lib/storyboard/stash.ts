import crypto from 'node:crypto'
import { createAdminClient } from '../supabase/admin'

export interface StoryboardIntake {
  script?: string
  file?: { id: string; url_private: string; name: string; filetype?: string; mimetype?: string }
  suggestedName?: string
  channelId: string
  userId: string
  assistantThreadTs?: string
  createdAt: number
}

const TTL_MS = 30 * 60 * 1000
const db = () => createAdminClient() as any

export async function stashIntake(intake: Omit<StoryboardIntake, 'createdAt'>): Promise<string> {
  const token = crypto.randomBytes(16).toString('hex')
  const payload = { ...intake, createdAt: Date.now() }
  const { error } = await db().from('storyboard_intakes').insert({
    token,
    payload,
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  })
  if (error) throw new Error(`Storyboard intake checkpoint failed: ${error.message}`)
  return token
}

export async function peekIntake(token: string): Promise<StoryboardIntake | null> {
  if (!token) return null
  const { data, error } = await db().from('storyboard_intakes')
    .select('payload,expires_at').eq('token', token).maybeSingle()
  if (error) throw new Error(`Storyboard intake read failed: ${error.message}`)
  if (!data || Date.parse(data.expires_at) <= Date.now()) return null
  return data.payload as StoryboardIntake
}

export async function deleteIntake(token: string): Promise<void> {
  if (!token) return
  const { error } = await db().from('storyboard_intakes').delete().eq('token', token)
  if (error) throw new Error(`Storyboard intake cleanup failed: ${error.message}`)
}

export async function updateIntake(
  token: string,
  patch: Partial<Omit<StoryboardIntake, 'createdAt'>>,
): Promise<void> {
  const existing = await peekIntake(token)
  if (!existing) throw new Error('Storyboard intake expired')
  const { error } = await db().from('storyboard_intakes')
    .update({ payload: { ...existing, ...patch } }).eq('token', token)
  if (error) throw new Error(`Storyboard intake update failed: ${error.message}`)
}
