# Workflow: Deployment

Keep two things separate: **repository validation** (what the repo can prove)
and **platform verification** (what only the running platform can prove).
Passing the first does not imply the second.

## Runtimes and their sources

See `.ai/runtime.md`. In short:

- **Railway** builds `bolt/Dockerfile` (context = repo root) and runs the
  persistent Bolt service. *(Build config Verified; deployed branch Needs
  verification.)*
- **Vercel** builds and runs the Next.js app + the Inngest functions
  registered in `src/app/api/inngest/route.ts`. *(Registry Verified; deployed
  branch and Inngest sync Needs verification.)*

## 1. Repository validation (before any deploy)

Per `.ai/validation.md`:

- Type-check the affected package(s).
- Run the relevant tests (`bolt/`'s `npm test` for Bolt changes).
- `npm run lint` and `npm run build` (root) for Vercel-bound changes.
- Confirm any schema change ships as a migration.

This proves the code compiles and tests pass. It proves **nothing** about the
live platforms.

## 2. Platform verification (after deploy)

Verify on the platform that actually runs the code — this cannot be done from
the repo:

- **Railway (Bolt):** the service is up and `/health` reports real Slack
  connectivity (not a stub); expected `node-cron` jobs are scheduled.
- **Vercel (web + crons):** the deployment succeeded; **Inngest is synced** so
  every function in `route.ts` is registered — an unsynced deploy silently
  stops all crons.
- **Supabase:** required migrations are applied to the target project.

## 3. What to check per change type

| Change touches | Repo validation | Platform verification |
|----------------|-----------------|-----------------------|
| `bolt/` or Bolt-used `src/lib/` | `bolt/` tests + `tsc` | Railway health + crons |
| `src/app/**`, Inngest functions | build + lint + `tsc` | Vercel deploy + Inngest sync |
| A migration | migration present, `tsc` | migration applied on Supabase |
| A studio worker (`kit-*`) | its own package checks | worker running on the studio PC |

## Exit / handoff

- Report repo validation run and its results, separately from any platform
  verification (and clearly mark platform steps you could not perform).
- Never claim a deploy succeeded from repo checks alone.

## Prohibited shortcuts

- Treating a green build as "deployed and working."
- Adding a new Inngest function without registering it in `route.ts`.
- Asserting Railway/Vercel dashboard state that is not visible in the repo.

## Stop and request a decision when

- The deployed branch/source for a platform is unknown and the change depends
  on it (invariant 12 / `.ai/runtime.md` unresolved questions).
