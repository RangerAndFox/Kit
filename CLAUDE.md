# Kit — Claude Code Bootstrap

Kit is Ranger & Fox's AI production-management system. It spans a persistent Slack Bolt service on Railway, a Next.js/Inngest service on Vercel, Supabase, and integrations including Dropbox, Frame.io, Harvest, Google Drive, and Google Calendar.

## Start here

Read this file first. Do not broadly explore the repository.

Then read only the smallest relevant reference:

- Repository ownership and entry points: `.ai/repo-map.md`
- System rules that must remain true: `.ai/invariants.md`
- Validation commands and order: `.ai/validation.md`
- Bug investigation workflow: `.ai/workflows/debugging.md`
- Feature workflow: `.ai/workflows/feature.md`

Do not read every `.ai/` document. Select only what the task requires.

## Operating rules

1. Minimize context. Identify the subsystem and exact entry point before reading implementation files.
2. Investigate before editing. State the reproduction path, violated invariant, root cause, analogous implementation, and plan.
3. Prefer existing architecture. Search for one relevant analogous path before introducing a new abstraction.
4. Fix mechanisms, not symptoms. Do not increase timeouts, suppress logs, or duplicate logic unless evidence shows that is the correct design.
5. Preserve runtime ownership. Railway owns persistent processes; Vercel owns Next.js and registered Inngest functions. Verify ownership before moving work across that boundary.
6. Preserve idempotency. External events, scheduled jobs, Slack messages, provisioning actions, and migrations must tolerate retries safely.
7. Keep scope narrow. No drive-by cleanup, unrelated dependency upgrades, file moves