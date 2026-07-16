# Repo map

Compact map of Kit's subsystems. Read the "read first" files for the subsystem
you are working on — not the whole directory. Runtime owners are detailed in
`.ai/runtime.md`; do not move work across owners without checking there.

Confidence: **V** = Verified in repo, **?** = Needs verification.

| Subsystem | Purpose | Primary entry point | Primary dirs | Runtime owner | Known validation | Read first | Conf. |
|-----------|---------|---------------------|--------------|---------------|------------------|-----------|-------|
| Slack Bolt app | Chat entry point: mentions, DMs, `/kit`, modals, node-cron jobs | `bolt/src/app.ts` (`tsx src/app.ts`) | `bolt/src/` | Railway | `bolt/` vitest (`npm test`) | `bolt/src/app.ts`, then the relevant `handlers/*` | V |
| Agent registry | Domain-expert agents + intent dispatch | `src/lib/inngest/agents/registry.ts` | `src/lib/inngest/agents/` | shared lib (used by Bolt) | none found | `agents/types.ts`, `agents/registry.ts` | V |
| Provisioner | Multi-service project creation | `src/lib/provisioner/` | `src/lib/provisioner/` | shared lib (used by Bolt) | none found | `provisioner/types.ts`, `provisioner/retry.ts` | V |
| Next.js web app | `/status` page and API routes | `src/app/` | `src/app/` | Vercel | `npm run build`, `npm run lint` | `src/app/status/page.tsx`, `src/app/api/status/route.ts` | V |
| Inngest crons | Scheduled/background functions (briefings, delivery scans, brain, transcripts, health) | `src/app/api/inngest/route.ts` | `src/lib/inngest/` | Vercel | none found | `src/app/api/inngest/route.ts` (function registry) | V |
| Delivery / transcode | Dropbox-driven delivery + transcode pipeline | `src/lib/delivery/` | `src/lib/delivery/`, `kit-render-worker/` | Vercel crons + studio worker | none found | `src/lib/delivery/` (see `dropbox-watcher.ts`) | V code / ? runtime |
| AE render farm | Renders AE projects across studio machines or Deadline | `src/lib/delivery/ae-storage.ts` | `src/lib/delivery/`, `kit-render-worker/src/aerender/`, `kit-deadline-relay/` | studio worker / Deadline relay | none found in repo | `AE-RENDER-FARM-HANDOFF.md`, then relay/worker `src/` | V code / ? setup |
| Health monitor | Live `/status` + Slack outage alerts | `src/lib/health/run.ts` | `src/lib/health/` | Vercel cron (`healthWatchdog`) + Bolt `/health` | `src/lib/health/*.test.ts` exist (runner unconfirmed) | `src/lib/health/run.ts`, `probes.ts`, `state.ts` | V code / ? test runner |
| Frame.io integration | Video review (Adobe IMS OAuth) | `src/lib/frameio/client.ts` | `src/lib/frameio/` | shared lib | none found | `frameio/auth.ts`, `frameio/client.ts` | V code / ? live |
| Dropbox integration | OAuth refresh-token file access | `src/lib/dropbox/client.ts` | `src/lib/dropbox/` | shared lib | none found | `dropbox/client.ts` | V |
| Google integrations | Drive transcripts + Calendar briefings | `src/lib/integrations/google-calendar.ts` | `src/lib/integrations/`, `src/lib/inngest/drive-transcripts.ts` | Vercel crons | none found | the specific integration file only | V code / ? runtime |
| Database | Schema + migrations | `supabase/migrations/` | `supabase/` | Supabase | migrations applied via Supabase MCP | the specific migration for your change | V |

## Notes

- **Shared code, two runtimes.** Everything under `src/lib/` is imported by
  both the Vercel app and the Railway Bolt service (`bolt/tsconfig.json` maps
  `@lib/*` → `../src/lib/*` and the Dockerfile copies `src/lib/` in). A change
  to `src/lib/` can affect both runtimes — check `.ai/runtime.md`.
- **Two package roots.** Root `package.json` (`kit-app`, Next.js) and
  `bolt/package.json` (`kit-bolt`, ESM, `tsx`) have separate dependency trees
  and different TypeScript targets (ES2017 vs ES2022). *(Verified.)*
- **Migration numbering collides.** Several prefixes are reused
  (`032`, `033`, `034`, `035` each appear on two files). Confirm ordering by
  reading filenames before adding a migration. *(Verified — see
  `.ai/audits/architecture.md`.)*
- **Top-level `agents/`, `docs/`, `scripts/`, `public/`** exist but were not
  inspected this sprint. *(Needs verification before relying on them.)*
