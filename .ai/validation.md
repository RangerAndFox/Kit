# Validation

Only commands that exist in the manifests, or are directly derivable from them,
are listed. **Do not invent scripts.** Where a canonical command is missing,
that is called out — treat the gap as real, not as license to fabricate one.

Costs are relative: **low** = seconds, **medium** = tens of seconds, **high** =
a full build or crosses a network/platform boundary.

## Prerequisites

Use Node 22 and install dependencies at both repo root and `bolt/`. Bolt's
`@lib/*` alias resolves shared code against root dependencies; installing only
Bolt dependencies causes misleading missing-module type errors.

## Commands

| Command | Working dir | Proves | Does *not* prove | Cost | When |
|---------|-------------|--------|------------------|------|------|
| `npm test` (`vitest run`) | `bolt/` | The Bolt package's vitest suite passes | Nothing about the Next.js/`src/app` code, or untested `src/lib/` modules | low–med | After any change under `bolt/` or shared code it exercises |
| `npm run test:watch` | `bolt/` | Same as above, iterative | Same | low | While iterating on a Bolt test |
| `npx tsc --noEmit` | repo root | Next.js app + `src/**` type-check (root `tsconfig`, `noEmit: true`) | No runtime behavior; excludes `bolt/` config | med | After changing `src/` or `src/app/` types |
| `npx tsc --noEmit` | `bolt/` | Bolt + its included `src/lib/**` type-check (`bolt/tsconfig`, `strict: false`) | Full `src/**`; strictness is relaxed here | med | After changing `bolt/` or the `src/lib` it imports |
| `npm run lint` (`eslint`) | repo root | Reports root and Bolt lint debt | Types, tests, runtime; currently not debt-free | low | Inspect touched-code debt |
| `npm run lint:ratchet` | repo root | No new errors over the tracked debt baseline | Does not mean clean lint | med | Every release |
| `npm run typecheck` | repo root | Root, Bolt, and tools configurations type-check | Runtime behavior | med | Every release |
| `npm run test:app` | repo root | Node/tsx suites under src, agents, scripts pass, including health and actual SQL fixtures | Provider runtime contracts | med | App/shared changes |
| `npm run check:migrations` | repo root | Migration naming, immutable baseline and ledger integrity | Live database application | low | Database changes |
| `npm run build` (`next build`) | repo root | The Vercel app compiles and builds | Bolt service; Inngest sync; production behavior | high | Before deploying web/cron changes |
| `npm start` (`tsx src/app.ts`) | `bolt/` | The Bolt service boots locally | Slack connectivity without real tokens | med | Local smoke test of the bot |

## Coverage boundaries

Root tests use Node's test runner via tsx; Bolt uses Vitest. Both are required.
Neither mocks nor green typechecks prove live provider contracts. The raw lint
stock is substantial; retain the ratchet and reduce debt without resetting the
baseline to hide regressions. SQL behavior tests use isolated PGlite; also verify
applied production versions and safe read-only invariants after deployment.

## Validation ladder (narrow → broad)

Run the cheapest step that could disprove your change first, then widen only as
needed. Stop as soon as a step fails — fix, then restart from that step.

1. **Directly affected test** — the one test covering the code you changed
   (or write one if the subsystem has tests).
2. **Subsystem tests** — the rest of that subsystem's suite (e.g. `bolt/`'s
   `npm test`).
3. **Affected package type check** — `npx tsc --noEmit` in the package you
   touched (`bolt/` and/or root).
4. **Package-wide checks** — `npm run lint:ratchet` (root) and `npm run typecheck`.
5. **Build** — `npm run build` (root) for Vercel-bound changes.
6. **Production verification** — platform-side confirmation (deploy logs,
   Inngest sync, `/health`, `/status`). Distinct from repo validation; see
   `.ai/workflows/deployment.md`). Required for a production release.
