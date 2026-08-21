# Kit

Kit is Ranger & Fox's studio operations assistant. It lives in Slack and connects project intake, project updates, Dropbox, Frame.io, Harvest, Google Calendar/Drive, Boords, the Master Project List, and the studio render systems.

Production repository: https://github.com/RangerAndFox/Kit

## What Kit does

- Creates projects across Slack, Dropbox, Harvest, and Frame.io from one Slack form.
- Updates an existing project's details and ripples approved changes across connected systems.
- Reconciles the update picker against live Slack project channels, adopting channels that exist in Slack but are missing from Kit and excluding deleted test channels.
- Mirrors files from a project's Dropbox `09_Outgoing/01_Client Progress` and `09_Outgoing/02_Delivery` folders into the corresponding Frame.io project and creates a public review share.
- Creates Boords storyboards from `.docx` or text scripts.
- Sends durable, timezone-aware daily hours prompts and writes confirmed entries to Harvest.
- Prepares concise meeting briefings with meeting information, external-attendee background, and Ranger & Fox positioning.
- Ingests meeting transcripts and studio knowledge for conversational project/client Q&A.
- Coordinates delivery/transcode and After Effects render-farm workflows.

See [FEATURES.md](FEATURES.md) for the detailed feature and integration reference.

## Slack entry points

- DM Kit and type `new project`, `update project`, or `storyboard`.
- `/kit newproject` opens the project provisioner.
- `/kit update` opens the existing-project picker and prefilled update form.
- `/storyboard` opens storyboard settings; `/storyboard resume <job-id>` resumes a timed-out job.
- `/kit deliver`, `/kit profiles`, `/kit workers`, `/kit sync-staff`, `/kit sync-projects`, and `/kit backfill-time` provide operator workflows.
- Mention `@Kit` in a channel for conversational help.

Strict DM shortcuts are registered once in `bolt/src/handlers/messages.ts` and shared by Slack's Assistant callback and plain-message fallback. Do not add a trigger directly to only one inbound path.

## Runtime ownership

Kit has two production runtimes plus optional studio workers:

| Runtime | Owns |
|---|---|
| Railway | Persistent Slack Bolt service, Socket Mode, Dropbox webhook for project outgoing files, hours/reminder jobs, update/provision recovery, Slack-facing scheduled work |
| Vercel + Inngest | Next.js status/API surface and durable serverless jobs: meeting briefings, transcript ingest, `/Delivery-Queue` scan, health checks, project-control sync, knowledge jobs |
| Supabase | Shared source of truth and durable workflow ledgers |
| Studio workers | FFmpeg delivery jobs and Deadline/After Effects relay work |

The two Dropbox automations are intentionally different:

- Railway watches `/production/<year>/<project>/09_Outgoing/{01_Client Progress,02_Delivery}` from Dropbox webhook deltas and mirrors project review files to Frame.io.
- Vercel/Inngest polls `/Delivery-Queue/` once per minute and coordinates profile-based transcodes with studio render workers.

Do not move or combine them without preserving those separate contracts. See [.ai/runtime.md](.ai/runtime.md) for the full boundary map.

## Local development

Requirements: Node 20.19+ (Railway uses the Node 20 image), npm, and the environment variables for the integrations being exercised.

Next.js/Inngest:

```bash
npm ci
npm run dev
```

Slack Bolt:

```bash
cd bolt
npm ci
npm run dev
```

## Verification

Before opening a pull request:

```bash
npm run build
cd bolt
npm ci
npm test
npx tsc --noEmit
npm audit
```

Run focused tests for the changed area first, then the complete Bolt suite. Commit both `package.json` and the matching lockfile for dependency changes.

## Deployment

- Merging `main` is expected to trigger the connected Vercel and Railway deployments.
- Vercel Preview deployments must register zero production Inngest functions unless a specific preview intentionally sets `KIT_INNGEST_ALLOW_PREVIEW=true`.
- Railway branch/source connection is dashboard state and should be verified after repository or GitHub-account changes.
- Database changes ship as new files under `supabase/migrations/`; verify the production migration list after merging.

Current operational follow-ups and verification-only checks live in [OPERATOR-TODO.md](OPERATOR-TODO.md). The current development handoff is [SESSION-HANDOFF.md](SESSION-HANDOFF.md).

## Key locations

- `bolt/src/app.ts` — persistent Slack service, webhook server, Railway schedules.
- `bolt/src/handlers/` — Slack commands, messages, cards, and interactions.
- `bolt/src/watchers/dropbox.ts` — Dropbox project-outgoing to Frame.io watcher.
- `src/lib/inngest/functions.ts` — canonical Vercel/Inngest function registry.
- `src/lib/agent/` — meeting classification, research, and briefing composition.
- `src/lib/inngest/agents/` — project-service provisioners.
- `supabase/migrations/` — database history.
- `kit-render-worker/` and `kit-deadline-relay/` — studio-local workers.
