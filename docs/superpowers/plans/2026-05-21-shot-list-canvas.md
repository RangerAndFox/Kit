# Shot List Canvas Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute.

**Goal:** Wire up a Boords/StudioBinder-style shot list that lives as a Slack Canvas inside the project channel. User @mentions Kit with a script → Kit parses to structured shots → renders a markdown shot table inside a channel canvas → tracks the canvas id in Supabase for later updates.

**Architecture:** All Slack interaction happens in the Bolt app (`bolt/src/shotlist/`). Claude Haiku parses scripts into structured shots. Slack's `conversations.canvases.create` creates the channel canvas; `canvases.edit` updates it. Supabase `shot_lists` table maps `(project_id, channel_id) → canvas_id` so subsequent edits update the existing canvas.

**Tech Stack:** Bolt v4 (Socket Mode), Slack Web API (canvases:write), Anthropic Haiku, Supabase admin client.

**Spec:** `docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md`

---

## Conventions

- Bolt files use `// @ts-nocheck`.
- New module lives at `bolt/src/shotlist/` alongside `bolt/src/onboarding/` and `bolt/src/checkins/`.
- Slack API calls use Bolt's `app.client` so auth + retries are inherited from Bolt.

---

## Task 1: Supabase migration `018_shot_lists.sql`

**File:** Create `supabase/migrations/018_shot_lists.sql` with:

```sql
-- 018_shot_lists.sql
-- Shot lists as Slack Canvases. One canvas per project channel; rows track
-- the channel↔canvas mapping so Kit can update existing canvases.
-- Spec: docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md

begin;

create table if not exists public.shot_lists (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete set null,
  slack_channel_id text not null,
  slack_canvas_id text not null,
  canvas_url text,
  shots_json jsonb not null default '[]'::jsonb,
  thumbnail_permalinks jsonb not null default '{}'::jsonb,
  last_rendered_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists shot_lists_channel_canvas_key
  on public.shot_lists (slack_channel_id, slack_canvas_id);

create index if not exists shot_lists_project_idx
  on public.shot_lists (project_id);

commit;
```

Commit:
```bash
git -C "C:/Users/studi/Kit" add supabase/migrations/018_shot_lists.sql
git -C "C:/Users/studi/Kit" commit -m "db: 018_shot_lists — schema for Slack canvas shot lists"
```

---

## Task 2: Shot list types + parser + renderer

**Files:**
- `bolt/src/shotlist/types.ts`
- `bolt/src/shotlist/parser.ts`
- `bolt/src/shotlist/renderer.ts`
- `bolt/scripts/test-shot-list-parser.ts`

`types.ts`:

```ts
// @ts-nocheck
/**
 * Shared types for the shot list feature.
 * Spec: docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md
 */

export interface Shot {
  number: number       // 1-indexed
  action: string
  dialogue?: string
  duration?: string
  notes?: string
}

export interface ShotList {
  shots: Shot[]
  title?: string
}

export interface ShotMutation {
  op: 'insert' | 'update' | 'delete' | 'replace_all'
  shot_number?: number       // for update/delete
  after_shot_number?: number // for insert
  shot?: Shot                // for insert/update
  shots?: Shot[]             // for replace_all
}
```

`parser.ts`:

```ts
// @ts-nocheck
/**
 * Shot list parser — Claude Haiku.
 *
 * Two modes:
 *   - parseScript: free-form script → Shot[]
 *   - parseMutation: free-form edit instruction → ShotMutation
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Shot, ShotMutation } from './types'

const SYSTEM_PARSE = `You break video/film scripts into structured shot lists.
Given a script or prose description, output a JSON array of shots. Each shot:
{ "number": <int 1..N>, "action": "<what happens visually>", "dialogue": "<spoken text or empty>", "duration": "<estimate like '2s' or 'TBD'>", "notes": "<camera/lens hints or empty>" }

Rules:
- Match the shot count to natural beats in the script. Aim for 3-15 shots.
- Action is REQUIRED. Dialogue/duration/notes are optional (use empty string if unknown).
- Output JSON only — no prose, no markdown fences.`

const SYSTEM_MUTATE = `You parse natural-language edit instructions into structured operations on a shot list.
Operations:
  - insert: { "op": "insert", "after_shot_number": <int>, "shot": {...} }
  - update: { "op": "update", "shot_number": <int>, "shot": {...} }
  - delete: { "op": "delete", "shot_number": <int> }
  - replace_all: { "op": "replace_all", "shots": [...] }

Output JSON only.`

function stripFences(text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  return new Anthropic({ apiKey })
}

export async function parseScript(script: string): Promise<Shot[]> {
  const client = getClient()
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: SYSTEM_PARSE,
    messages: [{ role: 'user', content: `Script:\n\n${script}\n\nReturn the JSON array.` }],
  })
  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
  const cleaned = stripFences(text)
  const parsed = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) throw new Error('Parser did not return a JSON array')
  // Normalize: 1-index and require action.
  return parsed
    .map((s: any, i: number) => ({
      number: typeof s.number === 'number' ? s.number : i + 1,
      action: String(s.action || '').trim(),
      dialogue: s.dialogue ? String(s.dialogue) : undefined,
      duration: s.duration ? String(s.duration) : undefined,
      notes: s.notes ? String(s.notes) : undefined,
    }))
    .filter((s: Shot) => s.action.length > 0)
    .map((s: Shot, i: number) => ({ ...s, number: i + 1 }))
}

export async function parseMutation(
  instruction: string,
  existingShots: Shot[],
): Promise<ShotMutation> {
  const client = getClient()
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_MUTATE,
    messages: [
      {
        role: 'user',
        content: `Current shot list (${existingShots.length} shots):\n${JSON.stringify(existingShots, null, 2)}\n\nEdit instruction:\n${instruction}\n\nReturn the JSON operation.`,
      },
    ],
  })
  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
  return JSON.parse(stripFences(text))
}
```

`renderer.ts`:

```ts
// @ts-nocheck
/**
 * Render a Shot[] into Slack canvas markdown.
 *
 * Slack canvases support GitHub-flavored markdown with simple tables
 * and inline images via `![](permalink)`.
 */

import type { Shot } from './types'

export function renderShotsToMarkdown(
  shots: Shot[],
  thumbnails: Record<number, string[]> = {},
  title?: string,
): string {
  const lines: string[] = []
  if (title) {
    lines.push(`# ${title}`, '')
  } else {
    lines.push('# Shot List', '')
  }

  if (shots.length === 0) {
    lines.push('_No shots yet. @mention Kit with a script to populate._')
    return lines.join('\n')
  }

  // Header row
  lines.push('| # | Visual | Sound / Dialogue | Duration | Reference |')
  lines.push('|---|---|---|---|---|')

  for (const s of shots) {
    const refs = thumbnails[s.number] || []
    const refCell = refs.length > 0
      ? refs.map((url) => `![](${url})`).join(' ')
      : '_drop image to add_'
    const visual = s.notes ? `${s.action}<br/>_${s.notes}_` : s.action
    const sound = s.dialogue || ''
    const duration = s.duration || ''
    lines.push(`| ${s.number} | ${visual} | ${sound} | ${duration} | ${refCell} |`)
  }

  lines.push('', `_${shots.length} shot${shots.length === 1 ? '' : 's'}. Last updated ${new Date().toISOString()}._`)
  return lines.join('\n')
}
```

`bolt/scripts/test-shot-list-parser.ts`:

```ts
// @ts-nocheck
/**
 * Smoke test for shot list parser.
 * SKIPs without ANTHROPIC_API_KEY.
 */

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('SKIP — ANTHROPIC_API_KEY not set.')
    process.exit(0)
  }
  const { parseScript } = await import('../src/shotlist/parser')

  const script = `INT. WAREHOUSE — DUSK
A figure walks into frame, silhouetted against window light.
CLOSE on the briefcase as they set it down on a steel table.
Hands open the latches. A glow spills upward.`

  const shots = await parseScript(script)
  console.log(`Parsed ${shots.length} shots:`)
  for (const s of shots) {
    console.log(`  ${s.number}. ${s.action.slice(0, 60)}${s.action.length > 60 ? '…' : ''}`)
    if (s.dialogue) console.log(`     dialogue: ${s.dialogue.slice(0, 40)}`)
    if (s.duration) console.log(`     duration: ${s.duration}`)
  }
  if (shots.length === 0) {
    console.error('FAIL — parser returned 0 shots')
    process.exit(1)
  }
  console.log('OK')
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

Commit:
```bash
git -C "C:/Users/studi/Kit" add bolt/src/shotlist/types.ts bolt/src/shotlist/parser.ts bolt/src/shotlist/renderer.ts bolt/scripts/test-shot-list-parser.ts
git -C "C:/Users/studi/Kit" commit -m "feat(shotlist): types + Haiku parser + markdown renderer"
```

---

## Task 3: Storage + canvas client + intent detector

**Files:**
- `bolt/src/shotlist/storage.ts`
- `bolt/src/shotlist/canvas.ts`
- `bolt/src/shotlist/keyword.ts`

`storage.ts`:

```ts
// @ts-nocheck
/**
 * Supabase read/write for shot_lists.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'
import type { Shot } from './types'

export interface ShotListRow {
  id: string
  project_id: string | null
  slack_channel_id: string
  slack_canvas_id: string
  canvas_url: string | null
  shots_json: Shot[]
  thumbnail_permalinks: Record<number, string[]>
  last_rendered_at: string | null
}

export async function findShotListByChannel(
  channelId: string,
): Promise<ShotListRow | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('shot_lists')
    .select('*')
    .eq('slack_channel_id', channelId)
    .maybeSingle()
  if (error) {
    console.warn('[shotlist] findShotListByChannel error:', error.message)
    return null
  }
  return (data as any) || null
}

export async function upsertShotList(row: {
  project_id?: string | null
  slack_channel_id: string
  slack_canvas_id: string
  canvas_url?: string | null
  shots: Shot[]
  thumbnails?: Record<number, string[]>
}): Promise<ShotListRow | null> {
  const sb = createAdminClient()
  const payload: any = {
    project_id: row.project_id ?? null,
    slack_channel_id: row.slack_channel_id,
    slack_canvas_id: row.slack_canvas_id,
    canvas_url: row.canvas_url ?? null,
    shots_json: row.shots,
    thumbnail_permalinks: row.thumbnails || {},
    last_rendered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await sb
    .from('shot_lists')
    .upsert(payload, { onConflict: 'slack_channel_id,slack_canvas_id' })
    .select('*')
    .maybeSingle()
  if (error) {
    console.warn('[shotlist] upsertShotList error:', error.message)
    return null
  }
  return (data as any) || null
}
```

`canvas.ts`:

```ts
// @ts-nocheck
/**
 * Slack canvas API wrapper.
 *
 * Uses Bolt's `app.client` for auth + retries.
 * Channel-canvas model: one canvas per channel via conversations.canvases.create.
 * If a channel already has a canvas, we error and ask the operator to clear it
 * (covered in spec §10 Open Questions).
 */

import type { App } from '@slack/bolt'

export interface CanvasHandle {
  canvas_id: string
  canvas_url: string | null
}

export async function createOrGetChannelCanvas(opts: {
  app: App
  channelId: string
  initialMarkdown: string
}): Promise<CanvasHandle> {
  const { app, channelId, initialMarkdown } = opts
  // Check for existing channel canvas first (conversations.info exposes a
  // `properties.canvas` block when one exists).
  try {
    const info = await app.client.conversations.info({ channel: channelId })
    const existing = (info as any)?.channel?.properties?.canvas
    if (existing?.file_id) {
      return {
        canvas_id: existing.file_id,
        canvas_url: existing.quip_thread_id || null,
      }
    }
  } catch (err: any) {
    // Non-fatal — fall through and try to create.
    console.warn('[shotlist] conversations.info failed:', err.message)
  }

  const created = await app.client.conversations.canvasesCreate({
    channel_id: channelId,
    document_content: { type: 'markdown', markdown: initialMarkdown },
  } as any)
  return {
    canvas_id: (created as any).canvas_id,
    canvas_url: (created as any).canvas_url || null,
  }
}

export async function updateCanvasMarkdown(opts: {
  app: App
  canvasId: string
  markdown: string
}): Promise<void> {
  const { app, canvasId, markdown } = opts
  await (app.client as any).canvases.edit({
    canvas_id: canvasId,
    changes: [
      {
        operation: 'replace',
        document_content: { type: 'markdown', markdown },
      },
    ],
  })
}
```

`keyword.ts`:

```ts
// @ts-nocheck
/**
 * Detect "shot list" intent in @Kit messages.
 *
 * Triggers on the substrings: "shot list", "shotlist", "shot-list", "shots".
 * Excludes the word "shots" when it's clearly unrelated (e.g., "shots of espresso")
 * by requiring a co-occurring verb like create/make/add/edit/build/give me/show.
 */

const SHOT_KEYWORDS = /\b(shot\s*list|shotlist|shot-list)\b/i
const SHOTS_WITH_VERB =
  /\bshots\b.{0,40}\b(create|make|add|edit|build|generate|give|show)\b|\b(create|make|add|edit|build|generate|give|show).{0,40}\bshots\b/i

export function isShotListTrigger(text: string): boolean {
  if (!text) return false
  if (SHOT_KEYWORDS.test(text)) return true
  if (SHOTS_WITH_VERB.test(text)) return true
  return false
}

/**
 * Extract the script body from a shot-list trigger message. Heuristic:
 *   - If the message contains "from this:" or "from:" or a colon followed by content, take everything after.
 *   - Otherwise return the full message (the LLM is robust to trigger words mixed in).
 */
export function extractScriptBody(text: string): string {
  const match = text.match(/(?:from\s+(?:this\s*)?:|:)\s*([\s\S]+)$/i)
  if (match && match[1].trim().length > 20) return match[1].trim()
  return text.trim()
}
```

Commit:
```bash
git -C "C:/Users/studi/Kit" add bolt/src/shotlist/storage.ts bolt/src/shotlist/canvas.ts bolt/src/shotlist/keyword.ts
git -C "C:/Users/studi/Kit" commit -m "feat(shotlist): storage, canvas client, keyword detector"
```

---

## Task 4: Main handler

**File:** `bolt/src/shotlist/handler.ts`

```ts
// @ts-nocheck
/**
 * Shot list handler — orchestrates parse → canvas create/update → confirm.
 *
 * Entry point: handleShotListMessage({ app, channelId, userId, text }).
 * Returns true if the message was handled, false otherwise.
 */

import type { App } from '@slack/bolt'
import { parseScript, parseMutation } from './parser'
import { renderShotsToMarkdown } from './renderer'
import { createOrGetChannelCanvas, updateCanvasMarkdown } from './canvas'
import { findShotListByChannel, upsertShotList } from './storage'
import { extractScriptBody } from './keyword'
import { createAdminClient } from '../../../src/lib/supabase/admin'

async function resolveProjectIdForChannel(channelId: string): Promise<string | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('id, external_links')
    .or(`external_links->>slack_id.eq.${channelId},external_links->>slack_channel_id.eq.${channelId}`)
    .maybeSingle()
  return data?.id ?? null
}

export async function handleShotListMessage(opts: {
  app: App
  channelId: string
  userId: string
  text: string
  threadTs?: string
}): Promise<boolean> {
  const { app, channelId, userId, text } = opts
  const existing = await findShotListByChannel(channelId)

  // Decide mode: if there's no existing list OR the message contains a fresh
  // script body, treat as parseScript. Otherwise parseMutation.
  const scriptCandidate = extractScriptBody(text)
  const looksLikeMutation =
    !!existing && /(\badd\b|\binsert\b|\bremove\b|\bdelete\b|\bedit\b|\bupdate\b|\bchange\b)/i.test(text)

  let shots
  try {
    if (looksLikeMutation && existing) {
      const mutation = await parseMutation(text, existing.shots_json || [])
      shots = applyMutation(existing.shots_json || [], mutation)
    } else {
      shots = await parseScript(scriptCandidate.length > 30 ? scriptCandidate : text)
    }
  } catch (err: any) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:warning: I couldn't parse that into shots: ${err.message || err}. Try again with a script or numbered shot list.`,
    })
    return true
  }

  if (!shots || shots.length === 0) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: ":thinking_face: I didn't see anything I could turn into shots. Paste a script or a numbered shot list and I'll structure it for you.",
    })
    return true
  }

  const projectId = await resolveProjectIdForChannel(channelId)
  const thumbnails = existing?.thumbnail_permalinks || {}
  const markdown = renderShotsToMarkdown(shots, thumbnails)

  let canvas
  try {
    if (existing?.slack_canvas_id) {
      await updateCanvasMarkdown({ app, canvasId: existing.slack_canvas_id, markdown })
      canvas = { canvas_id: existing.slack_canvas_id, canvas_url: existing.canvas_url }
    } else {
      canvas = await createOrGetChannelCanvas({ app, channelId, initialMarkdown: markdown })
    }
  } catch (err: any) {
    const detail = err?.data?.error || err?.message || String(err)
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:warning: I built the shot list but couldn't save it as a canvas: ${detail}. The Kit app may need the \`canvases:write\` scope — reinstall and try again.`,
    })
    return true
  }

  await upsertShotList({
    project_id: projectId,
    slack_channel_id: channelId,
    slack_canvas_id: canvas.canvas_id,
    canvas_url: canvas.canvas_url,
    shots,
    thumbnails,
  })

  await app.client.chat.postMessage({
    channel: channelId,
    text: `:clapper: Shot list ready — ${shots.length} shot${shots.length === 1 ? '' : 's'}. Open the channel Canvas tab to view. Drop image attachments in this thread to attach references to shots in order.`,
  })
  return true
}

function applyMutation(existing: any[], mutation: any): any[] {
  if (mutation.op === 'replace_all' && Array.isArray(mutation.shots)) {
    return renumber(mutation.shots)
  }
  let out = [...existing]
  if (mutation.op === 'insert' && mutation.shot) {
    const after = mutation.after_shot_number ?? out.length
    const idx = out.findIndex((s) => s.number === after)
    const insertAt = idx >= 0 ? idx + 1 : out.length
    out.splice(insertAt, 0, mutation.shot)
  } else if (mutation.op === 'update' && mutation.shot && mutation.shot_number != null) {
    const idx = out.findIndex((s) => s.number === mutation.shot_number)
    if (idx >= 0) out[idx] = { ...out[idx], ...mutation.shot, number: out[idx].number }
  } else if (mutation.op === 'delete' && mutation.shot_number != null) {
    out = out.filter((s) => s.number !== mutation.shot_number)
  }
  return renumber(out)
}

function renumber(arr: any[]): any[] {
  return arr.map((s, i) => ({ ...s, number: i + 1 }))
}
```

Commit:
```bash
git -C "C:/Users/studi/Kit" add bolt/src/shotlist/handler.ts
git -C "C:/Users/studi/Kit" commit -m "feat(shotlist): main handler — parse, canvas create/update, confirm"
```

---

## Task 5: Wire into Bolt message + command routers

**Files:**
- `bolt/src/handlers/messages.ts` — add intent detection inside `handleConversationalMessage` BEFORE the orchestrator fallback.
- `bolt/src/handlers/commands.ts` — add `/kit shotlist` subcommand.

### messages.ts edit

Locate the area where existing handlers (onboarding, ad-hoc hours, etc.) detect intent inside the `handleConversationalMessage` function. Add a new intent check ahead of the orchestrator fallback:

```ts
// Add to existing imports at top of file:
import { isShotListTrigger } from '../shotlist/keyword'
import { handleShotListMessage } from '../shotlist/handler'

// Inside handleConversationalMessage, near where onboarding/hours are detected:
if (isShotListTrigger(messageText)) {
  const handled = await handleShotListMessage({
    app,
    channelId,
    userId,
    text: messageText,
    threadTs: undefined, // shot lists post in-channel, not in-thread
  })
  if (handled) {
    await clearThinking({ channelId, userId, app })
    return
  }
}
```

Position this check AFTER the onboarding/ad-hoc-hours blocks but BEFORE the generic LLM orchestrator fallback.

### commands.ts edit

Add a new case to the `/kit` switch:

```ts
// Add to existing imports:
import { handleShotListMessage } from '../shotlist/handler'

// New case inside switch(subcommand):
case 'shotlist':
case 'shotlist:':
case 'shots': {
  await ack()
  // The remainder of the slash command text is the script body.
  await handleShotListMessage({
    app: undefined as any, // see note
    channelId: command.channel_id,
    userId: command.user_id,
    text: args || 'create a new empty shot list',
  })
  break
}
```

NOTE on `app: undefined` — Bolt's command callback exposes `client` directly rather than `app`. Refactor `handleShotListMessage` to accept `client` directly instead of `app`, OR construct a minimal shim. The simplest fix: change `handleShotListMessage` to take `{ client, channelId, userId, text, threadTs? }` where `client` is `app.client`. Update Task 4's handler signature and the messages.ts caller accordingly.

Commit (after applying both edits AND updating handler.ts to accept client):
```bash
git -C "C:/Users/studi/Kit" add bolt/src/handlers/messages.ts bolt/src/handlers/commands.ts bolt/src/shotlist/handler.ts
git -C "C:/Users/studi/Kit" commit -m "feat(shotlist): wire @mention + /kit shotlist into Bolt routers"
```

---

## Task 6: Docs

**Files:** `README.md` (no `.env.example` change — feature uses existing vars).

Add to README near the integrations/setup section:

```markdown
### Shot list canvas

Kit can build a Boords-style shot list directly inside a Slack channel as a Canvas:

- `@Kit shot list from this: <paste script>` — creates a channel canvas with structured shots.
- `@Kit add a close-up shot between 2 and 3` — edits the existing canvas.
- Drop image attachments in the same thread to attach reference thumbnails to shots in order.

Requires Slack scope `canvases:write` (re-install the Slack app after adding it).

Spec: `docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md`.
```

Commit:
```bash
git -C "C:/Users/studi/Kit" add README.md
git -C "C:/Users/studi/Kit" commit -m "docs: shot list canvas usage + scope note"
```

---

## Task 7: Final sweep

```bash
cd "C:/Users/studi/Kit" && npx tsc --noEmit
```

Expected clean.

```bash
git -C "C:/Users/studi/Kit" log --oneline main..feature/shot-list-canvas
```

Expected: 6-7 commits matching the tasks.

`git status --short`: empty.

---

## Definition of Done

- Migration `018_shot_lists.sql` present (not yet applied).
- `bolt/src/shotlist/` module exists with all 6 files (types, parser, renderer, canvas, keyword, storage, handler).
- `bolt/src/handlers/messages.ts` and `bolt/src/handlers/commands.ts` route to the handler.
- `npx tsc --noEmit` clean.
- PR opened against `main`.

## Rollout

1. Apply migration `018_shot_lists.sql`.
2. Add Slack scope `canvases:write` to the Kit app manifest in api.slack.com → Permissions.
3. Reinstall the Slack app in the workspace to pick up the new scope.
4. In a project channel, message `@Kit shot list from this:` followed by a paragraph or two of script. Confirm a canvas appears in the channel's Canvas tab.
