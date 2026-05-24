This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Integrations

### Plaud — meeting transcription

Plaud (https://plaud.ai) sends transcription events to `POST /api/webhooks/plaud`. Setup:

1. Create a dev app in the Plaud developer console.
2. Copy the webhook signing secret into `PLAUD_WEBHOOK_SECRET`.
3. Copy the API token into `PLAUD_API_KEY`.
4. Leave `PLAUD_INGEST_ENABLED=false` until you've verified a real recording produces a skeleton row in `call_transcripts`.
5. Once verified, set `KIT_DEFAULT_WORKSPACE_ID` to a real Supabase `workspaces.id` value (this attributes Plaud-derived sessions to the right workspace; the function throws loudly if unset), then flip `PLAUD_INGEST_ENABLED=true` to enable transcript fetch + RAG ingest. Backfill any pending skeleton rows by re-firing their `transcription.completed` events from the Plaud console.

Docs: https://docs.plaud.ai/

### Pre-meeting briefings (Google Calendar)

Kit can DM/post a context briefing ~30 minutes before each meeting. Setup:

1. Create a Google Cloud service account; download its JSON.
2. Share each Kit-relevant calendar with the service account's `client_email`. Read-only is sufficient.
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (raw or base64-encoded) and `GOOGLE_CALENDAR_IDS` (comma-separated) in Railway.
4. Flip `GOOGLE_CALENDAR_INGEST_ENABLED=true`.
5. The `preMeetingScan` cron runs every 15 minutes via Inngest.

Spec: `docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md`.

### Shot list canvas

Kit can build a Boords-style shot list directly inside a Slack channel as a Canvas:

- `@Kit shot list from this: <paste script>` — creates a channel canvas with structured shots.
- `@Kit add a close-up shot between 2 and 3` — edits the existing canvas.
- Drop image attachments in the same thread to attach reference thumbnails to shots in order.

Requires Slack scope `canvases:write` (re-install the Slack app after adding it).

Spec: `docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md`.

### Studio knowledge (project history RAG)

Kit can answer questions about the studio's full project history, contacts, budgets, and freeform notes. Backed by OpenAI text-embedding-3-small + pgvector + the `match_documents` Supabase RPC.

Setup:
1. Set `OPENAI_API_KEY` in Railway.
2. Set `KIT_DEFAULT_WORKSPACE_ID` if not already set.
3. Run the one-shot backfill to pull all Harvest projects into Supabase + embed them: `npx tsx scripts/backfill-projects-from-harvest.ts`
4. Run the contacts backfill to pull Harvest clients + contacts: `npx tsx scripts/backfill-clients-from-harvest.ts`
5. From Slack, ask Kit anything: "who do we talk to at Microsoft?", "biggest project this year?", "what was the brief for the Nike sizzle?". The `ask_studio_knowledge` tool fires automatically.

The agent exposes ten actions: `search` (semantic RAG over embedded docs), `lookup_project` (structured by code/name/client), `recent_projects`, `reembed_all` (heavy, after a project backfill or schema change), `lookup_client` (client by name, exact then fuzzy), `find_contact` (find a person across all clients by name/email/title), `recent_clients` (ordered by lifetime revenue), `reembed_clients` (heavy, after a contacts backfill), `reembed_transcripts` (backfill any ingested call_transcripts not yet in the RAG store), and `regenerate_summary` (Claude Haiku 1-pager for one project or all).

#### Notes capture

Save a freeform note to a project from any Slack channel:

- `@Kit note for Rayfin: client wants no logos in the lower thirds` — explicit project.
- `@Kit note: VFX cleanup is going to push delivery by 2 days` — implicit project (uses the channel's linked Kit project).
- `@Kit remember that the client signs off on Thursdays for Acme` — natural phrasing.
- `/kit note Rayfin | client wants no logos` — slash-command variant (pipe-separated).

Notes are embedded immediately. The next time you ask Kit anything about that project, the note shows up in the answer.

Once Plaud is activated and transcripts flow into `call_transcripts`, they're auto-embedded for retrieval. Older transcripts can be backfilled with `ask_studio_knowledge reembed_transcripts` from any Slack channel.

#### Nightly auto-summarization

Once the foundation is populated (projects + notes + transcripts), Kit can nightly regenerate each project's 1-pager summary by feeding the recent notes/transcripts/actions to Claude Haiku and re-embedding the result. This keeps the project_summary doc current with narrative context, not just structural data.

Enable with `STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED=true` in Railway. The cron runs at 9am UTC (5am ET). To trigger manually for one project: `ask_studio_knowledge regenerate_summary` with a `projectId`. To regenerate all: omit `projectId`.

### Delivery pipeline (FFmpeg transcoding)

Kit can transcode files from Dropbox to broadcast delivery specs (ProRes, loudness normalization, channel mapping, naming conventions). Architecture:

- Drop a file into `/Delivery-Queue/` on Dropbox.
- Kit posts to `DELIVERY_NOTIFY_CHANNEL_ID` Slack channel — pick a delivery profile.
- One or more render workers (studio PCs running `kit-render-worker/`) claim and transcode the job.
- Output lands in `/Delivery-Queue/.../delivery/` with the correct filename.

Slash commands:
- `/kit deliver <path>` — open the profile-selection modal for a specific Dropbox file
- `/kit deliver status` — recent jobs + their progress
- `/kit profiles` / `/kit profiles create` — manage delivery spec profiles
- `/kit workers` / `/kit workers opt-out <hostname>` / `/kit workers opt-in <hostname>` — manage the render pool

**Cron note:** Inngest's minimum cron granularity is 1 minute; the Dropbox watcher polls every 60s (not 30s as the spec optimistically targets). Practical detection latency is ~60-90s after upload completes.

Render workers are installed separately — see `kit-render-worker/README.md`. Spec: `DELIVERY-PIPELINE-SPEC.md`.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
