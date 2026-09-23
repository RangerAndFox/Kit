import type { WebClient } from '@slack/web-api'

type Person = { id?: string; deleted?: boolean; is_bot?: boolean; real_name?: string; profile?: { real_name?: string; display_name?: string; email?: string } }
export type ArtistLookup = { kind: 'matched'; name: string; email: string } | { kind: 'unmatched' | 'ambiguous' | 'unavailable' | 'conflict' }
const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const active = (p: Person) => !!p.id && !p.deleted && !p.is_bot && p.id !== 'USLACKBOT'

/** Resolve identity from Slack, never from an email guessed by the model. */
export async function resolveExistingArtist(client: WebClient, text: string, name: string | null, email: string | null): Promise<ArtistLookup> {
  const mentions = [...new Set([...text.matchAll(/(?:<@([UW][A-Z0-9]+)(?:\|[^>]+)?>|@([UW][A-Z0-9]+)\b)/g)].map(m => m[1] || m[2]))]
  if (mentions.length > 1) return { kind: 'ambiguous' }
  try {
    let person: Person | undefined
    if (mentions.length === 1) {
      const result = await client.users.info({ user: mentions[0] })
      if (!result.ok || !result.user || result.user.id !== mentions[0]) return { kind: 'unavailable' }
      person = result.user
    } else {
      if (email || !name) return { kind: 'unmatched' }
      const candidates = new Map<string, Person>()
      let cursor: string | undefined
      // Finish the directory scan before claiming a name is unique.
      for (let page = 0; page < 10; page++) {
        const result = await client.users.list({ limit: 200, cursor })
        if (!result.ok) return { kind: 'unavailable' }
        for (const p of result.members || []) {
          const names = [p.real_name, p.profile?.real_name, p.profile?.display_name].filter(Boolean) as string[]
          if (active(p) && names.some(n => normalized(n) === normalized(name) || normalized(n).split(' ')[0] === normalized(name))) candidates.set(p.id!, p)
        }
        cursor = result.response_metadata?.next_cursor?.trim() || undefined
        if (!cursor) break
      }
      if (cursor) return { kind: 'unavailable' }
      if (candidates.size > 1) return { kind: 'ambiguous' }
      person = [...candidates.values()][0]
    }
    if (!person || !active(person)) return { kind: 'unmatched' }
    const actualEmail = person.profile?.email?.trim()
    if (!actualEmail) return { kind: 'unavailable' }
    if (email && normalized(email) !== normalized(actualEmail)) return { kind: 'conflict' }
    return { kind: 'matched', email: actualEmail, name: person.profile?.real_name || person.real_name || person.profile?.display_name || name || actualEmail.split('@')[0] }
  } catch {
    return { kind: 'unavailable' }
  }
}
