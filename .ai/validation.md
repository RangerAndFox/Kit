# Validation

Only commands that exist in the manifests, or are directly derivable from them,
are listed. **Do not invent scripts.** Where a canonical command is missing,
that is called out — treat the gap as real, not as license to fabricate one.

Costs are relative: **low** = seconds, **medium** = tens of seconds, **high** =
a full build or crosses a network/platform boundary.

## Commands

| Command | Working dir | Proves | Does *not* prove | Cost | When |
|---------|-------------|--------|------------------|------|------|
| `npm test` (`vitest run`) | `bolt/` | The Bolt package's vitest suite passes | Nothing about the Next.js/`src/app` code, or untested `src/lib/` modules | low–med | After any change under `bolt/` or shared code it exercises |
| `npm run test:watch` | `bolt/` | Same as above, iterative | Same | low | While iterating on a Bolt test |
| `npx tsc --noEmit` | repo root | Next.js app + `src/**` type-check (root `tsconfig`, `noEmit: true`) | No runtime behavior; excludes `bolt/` config | med | After changing `src/` or `src/app/` types |
| `npx tsc --noEmit` | `bolt/` | Bolt + its included `src/lib/**` type-check (`bolt/tsconfig`, `strict: false`) | Full `src/**`; strictness is relaxed here | med | After changing `bolt/` or the `src/lib` it imports |
| `npm run lint` (`eslint`) | repo root | ESLint passes for the Next.js app | Types, tests, runtime | low | Before finishing web/`src/app` work |
| `npm run build` (`next build`) | repo root | The Vercel app compiles and builds | Bolt service; Inngest sync; production behavior | high | Before deploying web/cron changes |
| `npm start` (`tsx src/app.ts`) | `bolt/` | The Bolt service boots locally | Slack connectivity without real tokens | med | Local smoke test of the bot |

## Missing / non-canonical commands (gaps)

- **No repo-wide test command.** The root `package.json` (`kit-app`) has **no
  `test` script** and no test runner in its dependencies. *(Verified.)*
- **Orphaned test files.** `src/lib/health/*.test.ts` exist, but the root
  package has no vitest config/dependency and `bolt/tsconfig.json` does not
  include `src/lib/health`. Which runner executes them is **Needs
  verification** — do not assume `bolt/`'s `npm test` covers them.
- **No shared type-check-everything command.** Root and `bolt/` type-check
  separately with different `tsconfig` targets and strictness.
- **No lint for `bolt/`.** Lint is only wired for the root package.

These gaps are a discovery-cost issue — see `.ai/audits/ai-efficiency.md`.
Adding canonical scripts is out of scope for this docs-only sprint.

## Validation ladder (narrow → broad)

Run the cheapest step that could disprove your change first, then widen only as
needed. Stop as soon as a step fails — fix, then restart from that step.

1. **Directly affected test** — the one test covering the code you changed
   (or write one if the subsystem has tests).
2. **Subsystem tests** — the rest of that subsystem's suite (e.g. `bolt/`'s
   `npm test`).
3. **Affected package type check** — `npx tsc --noEmit` in the package you
   touched (`bolt/` and/or root).
4. **Package-wide checks** — `npm run lint` (root) and the full type check.
5. **Build** — `npm run build` (root) for Vercel-bound changes.
6. **Production verification** — platform-side confirmation (deploy logs,
   Inngest sync, `/health`, `/status`). Distinct from repo validation; see
   `.ai/workflows/deployment.md`. Not part of this sprint.
