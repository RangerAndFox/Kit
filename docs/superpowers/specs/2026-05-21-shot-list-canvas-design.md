# Shot List in Slack Canvas — Design Spec

**Date:** 2026-05-21
**Status:** Approved for implementation (user directed autonomous execution)

---

## 1. Problem

Producers and CDs at Ranger & Fox break scripts into shot lists by hand — usually in StudioBinder or Boords. Kit already has a Boords integration (it can create storyboards from a script), but the resulting board lives outside the Slack channel where the team actually works.

This spec adds a **Boords/StudioBinder-style shot list as a Slack Canvas** that lives directly inside the project channel. A user @mentions Kit with "make a shot list from this script" (or pastes shots inline), Kit creates a canvas attached to the channel, and the canvas renders as a structured table of shots with optional thumbnail images. The canvas updates over time as the user adds/removes/refines shots conversationally.

## 2. Decisions made autonomously

| Decision | Choice | Why |
|---|---|---|
| Slack surface | **Channel canvas** (`conversations.canvases.create`) | One canvas per project channel = simple mental model; appears in the channel's "Canvas" tab; user accesses via the existing channel UI rather than a separate bookmark. |
| Content format | **Markdown table** rendered inside the canvas | Slack canvases accept Markdown including simple tables and inline images. Matches Boords' shot/action/sound/dialogue layout. |
| Trigger surface | **Conversational @mention** (e.g. "Kit, shot list from this:") | User's stated preference from earlier conversation; aligns with the onboarding flow's pattern. Also expose a backup slash command `/kit shotlist` for power-users. |
| Script parser | **Claude Haiku** | Already wired up; cheap; good at structure extraction. |
| Thumbnails v1 | **User-supplied** via Slack file uploads (drag/drop into the reply); Kit embeds via permalink | Doesn't require new image-gen credentials. AI-generated thumbnails (Adobe Firefly via existing IMS auth) added behind a flag in a follow-up. |
| Storage | One Supabase table `shot_lists` mapping project_id ↔ canvas_id ↔ channel_id | Lets Kit find the existing canvas to update on subsequent requests. Canvas content itself is sourced from Slack (Slack is source of truth for the rendered output). |
| Sync to Boords | **Deferred** as opt-in follow-up | Kit's Boords integration already exists; surfacing a "Push to Boords" button on the canvas is small future work. |
| Activation gating | **No flag** — feature is on as soon as scopes are added | Unlike Plaud/Briefings, this feature only needs Slack permissions (no external creds). |
| Codebase placement | **`bolt/src/shotlist/`** subdirectory | Lives next to the existing onboarding flow in the Bolt app; Slack interactions happen there, not in the Next.js app. |
| Anthropic SDK | Reuse the same client pattern as the meeting classifier | Consistency. |
| Update model | **Full canvas replace** on edits | Race-conditiony for concurrent editors, but simple. Slack canvases are designed to be edited in-place by the bot. |

## 3. Goals

1. Add a Bolt message-handler that detects "shot list" intent in @Kit messages and routes to the shot-list pipeline.
2. Add `/kit shotlist` slash command as a power-user alternative.
3. Parse free-form script text into structured shots via Claude Haiku.
4. Create a channel canvas via `conversations.canvases.create` (or edit an existing one via `canvases.edit`) and render the shot list as a markdown table with image embeds.
5. Persist `shot_lists` row mapping project ↔ canvas so subsequent edits update the existing canvas.
6. Support thumbnail attachments: when a user replies to the shot-list confirmation with image uploads, Kit attaches them to specific shots (by following the parser's shot order or by explicit "shot 3 thumbnail" prompt).
7. Add Slack scopes documentation (`canvases:write`, `conversations.connect:write`-not-this-one, `files:write` for uploads, `bookmarks:write` is unnecessary because we use the channel-canvas slot).

## 4. Non-Goals

- AI-generated thumbnails (Firefly / DALL-E / Stability) — follow-up.
- Multi-canvas per project (versioned shot lists, drafts) — for now one living canvas per project channel.
- Two-way sync with Boords — Kit can already create a Boords storyboard; a "Push to Boords" button is a small future addition.
- Editing the canvas through anything other than re-prompting Kit (no in-canvas editing recognition).
- Real-time collaboration (multiple producers editing simultaneously — last write wins).
- Versioning / history of shot list changes beyond what Slack's canvas history provides natively.

## 5. Architecture

```
Slack channel
  │
  │  @Kit make a shot list from this script: [PASTED_SCRIPT]
  ▼
bolt/src/handlers/messages.ts
  → isShotListTrigger(text) → true
  → route to bolt/src/shotlist/handler.ts
  ▼
parseShotsFromScript(script) — Claude Haiku
  → returns ShotList[] = [{ number, action, dialogue?, duration?, notes? }]
  ▼
upsertShotListRecord(projectId, channelId) → Supabase row
  → if shot_lists row exists for (project_id, channel_id): use its canvas_id
  → else: conversations.canvases.create({ channel_id }) → new canvas_id; insert row
  ▼
renderShotListMarkdown(shots, thumbnails?) → markdown blob
  ▼
canvases.edit({ canvas_id, document_content: { type: 'markdown', markdown } })
  ▼
chat.postMessage in the channel: "Shot list ready — open the Canvas tab. [link]"
```

### Thumbnail flow

```
User uploads an image as a reply to Kit's "Shot list ready" message
  ▼
Slack file_shared event → bolt/src/handlers/files.ts
  → if thread_ts matches a pending shot-list confirmation:
      → resolve next un-thumbnailed shot
      → upload file as a public-permalink-allowed Slack file
      → update shot_lists row with thumbnail_permalinks JSON
      → re-render canvas via canvases.edit
```

### Update flow

```
User: "@Kit add a shot for the reveal between 4 and 5"
  ▼
detectShotListMutation(text) — Haiku, structured output
  → { op: 'insert', after_shot_number: 4, shot: {...} }
  ▼
apply mutation to stored ShotList[]
  ▼
re-render canvas
```

## 6. Components

### Added

- `supabase/migrations/016_shot_lists.sql` — table for canvas tracking.
- `bolt/src/shotlist/types.ts` — `Shot`, `ShotList`, `ShotMutation` types.
- `bolt/src/shotlist/parser.ts` — Haiku call: free-form script → `Shot[]`.
- `bolt/src/shotlist/renderer.ts` — `Shot[]` → markdown table.
- `bolt/src/shotlist/canvas.ts` — Slack canvas API wrappers (`createOrGet`, `update`).
- `bolt/src/shotlist/storage.ts` — Supabase read/write for the `shot_lists` table.
- `bolt/src/shotlist/handler.ts` — main entry point; orchestrates parse → store → render → post.
- `bolt/src/shotlist/keyword.ts` — `isShotListTrigger(text)` detector and intent parser.
- `bolt/src/handlers/files.ts` — file_shared handler for thumbnail attachments (or extended existing handler).

### Modified

- `bolt/src/handlers/messages.ts` — wire the shot-list trigger into the @mention router.
- `bolt/src/handlers/commands.ts` — add `/kit shotlist` subcommand.
- `bolt/src/app.ts` — register a `file_shared` event listener if not already present.
- `.env.example` — no new env vars required (uses existing `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, Supabase).
- `README.md` — short "Shot list canvas" section.
- Slack app manifest / docs note — operator must add `canvases:write` scope and reinstall the app.

### Untouched

- Boords integration (`src/lib/boords/client.ts`) — stays separate; future "Push to Boords" button references it.
- Next.js app — this feature is entirely in the Bolt app.

## 7. Data model

`shot_lists`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `project_id` | uuid | references `projects(id)`; nullable for ad-hoc lists outside a project channel |
| `slack_channel_id` | text not null | The channel where the canvas lives |
| `slack_canvas_id` | text not null | Slack's canvas id (e.g. `F12345...`) |
| `canvas_url` | text | Permalink |
| `shots_json` | jsonb not null default '[]' | Source-of-truth structured `Shot[]`; canvas markdown is derived from this |
| `thumbnail_permalinks` | jsonb default '{}' | Map of `shot_number` → array of Slack file permalinks |
| `last_rendered_at` | timestamptz | |
| `created_at` | timestamptz default now() | |
| `updated_at` | timestamptz default now() | |

Indexes: unique on `(slack_channel_id, slack_canvas_id)`, btree on `project_id`.

`Shot` shape (in `shots_json`):

```ts
interface Shot {
  number: number      // 1-indexed shot order
  action: string      // what happens visually
  dialogue?: string   // spoken VO / on-screen dialogue
  duration?: string   // freeform — "2s", "0:05", "TBD"
  notes?: string      // camera, lens, etc.
}
```

## 8. Configuration

**No new env vars.** Uses existing `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

**Slack scopes (operator step):**
- `canvases:write` — create/edit canvases
- `canvases:read` — read canvas content (optional but useful for "show me the current shot list")
- `files:write` — already present (for thumbnail uploads if Kit ever uploads them itself)
- The operator must reinstall the Slack app after adding these scopes.

## 9. Testing

- Unit: `bolt/scripts/test-shot-list-parser.ts` — fixture scripts → expected `Shot[]` structure; SKIPs without `ANTHROPIC_API_KEY`.
- Integration (requires Slack workspace + canvases scope):
  1. In a project channel, message `@Kit shot list from this: [3-shot script]`.
  2. Confirm a canvas appears in the channel's Canvas tab with 3 rows.
  3. Reply to Kit with an image attached.
  4. Confirm the canvas updates with the image embedded into shot 1.
  5. Send `@Kit add a shot between 2 and 3 for the close-up`.
  6. Confirm canvas now has 4 shots.

## 10. Open Questions / Risks

- **Canvas markdown rendering quirks.** Slack canvas markdown is documented but practice tends to surface edge cases (e.g., table column widths, image sizing). Mitigation: keep markdown simple and test against a real channel before claiming v1 done.
- **One-canvas-per-channel constraint.** If a project channel uses its canvas for something else (a brief, a styleguide), Kit's shot list would overwrite it. Mitigation: check for existing canvas before creating; if present, error and suggest the user clear it first.
- **Thumbnail-to-shot mapping.** "User uploads image as reply" → "attach to next un-thumbnailed shot" is heuristic. A user uploading three images for shots 1/2/3 vs uploading one image for shot 3 looks identical at the file_shared event level. v1 picks the simplest rule (in-order fill); add explicit "shot N thumbnail:" mention syntax later.
- **Slack canvas markdown size limit (800 KB).** A shot list with thousands of rows hits this. Realistic max is 50-100 shots; warn at 80.
- **Concurrent edits.** Two producers asking Kit to modify the shot list simultaneously can race. Mitigation: per-canvas advisory lock in Supabase (or simple `updated_at` optimistic concurrency).

---

**Next step:** implementation plan at `docs/superpowers/plans/2026-05-21-shot-list-canvas.md`.
