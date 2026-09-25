# Kit — Independent Code, Security & Production Setup Audit

> Historical independent analysis, not a current release attestation. The later
> heartbeat/transfer addendum contained claims corrected during Codex review:
> ready siblings do not prove another revision delivered; Behance previously
> acknowledged before Slack success; retirement required atomic transactions
> and stronger grants. Use KIT-HEARTBEAT-DEPLOYMENT-REVIEW-2026-09-24.md and
> KIT-DELIVERY-TRANSFER-RECONCILIATION-2026-09-24.md for the corrected release scope
> and evidence. Unrelated original audit findings remain separate backlog work.

**Date:** 2026-09-24
**Auditor:** Independent senior engineering review (read-only)
**Audited commit:** `871e0d5` — *"Preserve Dropbox rename aliases and verify actual media downloads (#192)"*
**Repository:** https://github.com/RangerAndFox/Kit

---

## 0. Audit scope, method, and provenance

This is a **read-only** independent audit. No production configuration, live database records, queued jobs, Slack messages, credentials, or external content were modified. Findings were verified in the actual code at the audited commit — documentation, comments, prior "fix" commit messages, and passing tests were treated as **claims to verify**, not proof.

**Method.** The audit combined (a) direct code reading and independent verification by the lead reviewer, (b) four parallel deep-dive reviews (security; integration reliability; product workflows; performance/maintainability) whose top findings were then re-verified against the code by the lead, and (c) authoritative production signal pulled read-only from Supabase (advisors, row counts) and Vercel (deployed revision).

### Local / main / deployed reconciliation

| Surface | Revision | State | How established |
|---|---|---|---|
| Local checkout | `871e0d5` on `claude/kit-independent-audit-4yknn1` | **clean** (no uncommitted changes) | `git status`/`git log` |
| `origin/main` | `871e0d5` | — | `git log origin/main` |
| **Vercel production** | `871e0d5` (`main`) | **READY** | Vercel MCP `list_deployments` (deployment `dpl_DyMUwCk…`) |
| Railway (Bolt service) | **Not verified** | — | Health endpoint proxy-blocked (403) from the audit environment |
| Supabase | 118 migrations, baseline sha verified | — | `check-migrations.mjs` + Supabase MCP `get_advisors` |

**Local == main == deployed Vercel.** The Railway-deployed revision could not be confirmed independently (the audit environment's outbound proxy blocks `kit-production-d273.up.railway.app`). Any statement about *running* Railway behavior below is therefore code-level, not runtime-confirmed.

### Production scale (authoritative, read-only)

`select count(*)` on production Supabase: **1 workspace, 259 projects, 10 staff.** Kit is **effectively single-tenant** (one Slack workspace / one studio). This is the single most important framing fact in this report: Kit's code carries elaborate `workspace_id` multi-tenant scoping, but only one tenant is live. Several findings below are therefore **latent** — real defects in the code that cannot be exploited or observed today because there is only one workspace, but that become live the moment a second workspace (or Slack Connect team) is added.

---

## 1. Executive summary

**Overall assessment: strong and unusually well-hardened, with a small number of real defects and one clear cost problem.** Kit has visibly been through prior security and reliability hardening, and most of the disciplines its own `.ai/` "Atlas" layer claims actually hold in code: verify-before-side-effect with fail-closed webhook auth, durable provisioning ledgers with reconcile-by-marker, `id@rev` dedup that correctly neutralizes folder-rename re-uploads, constant-time secret comparisons, RLS on every table, a squashed-baseline migration model with an integrity check, and genuinely thoughtful anti-false-alarm sync alerting. Independent checks found **no committed secrets** (working tree or git history), **`npm audit --production` = 0 vulnerabilities**, a tight CSP, and **961 passing Bolt tests**.

The weak spots cluster in four places: (1) **inference cost** — the conversational orchestrator runs on Opus on every Slack turn; (2) a **retry-safety defect** in the Delivery-Queue Inngest scan that can double-fire notifications; (3) a handful of **product-workflow gaps** where an entry gate and its execution gate disagree, or a user-facing message overstates what happened (onboarding); and (4) **latent multi-tenant leaks** that are harmless at one workspace but would matter at two. The Next.js web app also ships several dead-end navigation pages.

### Five highest-priority actions

1. **Cut orchestrator inference cost (PERF‑1).** `ORCHESTRATOR_MODEL = 'claude-opus-4-7'` is invoked on *every* Slack turn purely to route to Haiku specialists and emit ≤1024 tokens; the module's own docstring says "Call Sonnet." Move it to Sonnet (or Haiku), validate routing quality. One-line change, largest recurring saving.
2. **Fix Delivery-Queue duplicate notifications (REL‑1).** The non-SRT notify+mark and caption Slack posts run *outside* `step.run`, so an Inngest step-boundary re-invocation (common case: `movie.mp4` + `movie.srt` dropped together) or a retry re-posts the earlier file's prompt — risking duplicate operator "run `/kit deliver`" prompts and a double transcode. Wrap each file's notify+mark in its own durable step.
3. **Stop the ad-hoc Harvest double-log (PRD‑6).** Ad-hoc hours use an idempotency marker scoped to the check-in row id; each ad-hoc message creates a *new* row, so re-sending identical hours and confirming both cards writes Harvest twice. Content-address the idempotency key. **Direct billing-integrity impact.**
4. **Close the two onboarding truthfulness/authorization gaps (PRD‑2, PRD‑5).** A CD-role user passes the onboarding entry gate then hard-fails at execution; and the Frame.io onboarding message claims a signup link was "sent" when, for a brand-new freelancer, no welcome is delivered at all. Both cause silent onboarding stalls.
5. **Remove the latent cross-workspace paths before a second workspace is ever added (SEC‑1, SEC‑2, PRD‑7).** Bind the MCP acting identity into the signed token (not a caller-supplied `slack_user_id`), make `match_documents`' workspace filter mandatory, and fail closed (not "first workspace") on an unknown Slack team id.

---

## 2. Architecture & feature inventory

### 2.1 Runtime topology (verified in code)

- **Railway — persistent Slack Bolt service** (`bolt/src/app.ts`, Socket Mode, `node-cron`). Owns: conversational entry, `/kit` commands, modals, onboarding/offboarding, hours check-ins, the `/production/**/09_Outgoing` → Frame.io mirror webhook, project-control recovery sweeps, celebrations, culture posting. **Slack has no HTTP route** — it arrives only over Socket Mode.
- **Vercel — Next.js app + Inngest functions** (`src/app/`, `src/app/api/inngest/route.ts`). Owns: `/status` + dashboard, API routes, and 15 registered Inngest crons (delivery scans, briefings, brain, transcripts, health, project-control sync). Registration is fail-closed on Preview (`selectRegisteredFunctions`).
- **Supabase — Postgres source of truth** (97-table baseline + 118 migrations). RLS on every table; service-role-only for backend tables.
- **Studio workers** — `kit-render-worker/`, `kit-deadline-relay/`, `kit-behance-worker/`. Runtime presence not verifiable from this environment.

**Ownership boundaries hold.** The previously-flagged "Dropbox `/production` has more than one observer" open question is **resolved / can be closed**: three watchers exist but over **disjoint path filters with independent persisted cursors** — Railway `bolt/src/watchers/dropbox.ts` (`09_Outgoing` + `08_AE/03_RenderFarm`), Vercel `specs-watcher.ts` (`…/specs/…`), and Vercel `deliveryDropboxScan` (a *different root*, `/Delivery-Queue`). No duplicate event handling; invariant 10 (explicit cursor ownership) holds.

### 2.2 Feature inventory

Classification: **Live** / **Partial** / **Disabled** (implemented, intentionally inert) / **Dormant** (implemented, no working invocation path) / **Obsolete** / **Deferred**.

| Feature | Class | Evidence |
|---|---|---|
| NL commands + `/kit` dispatch + help + confirm/cancel | Live | `bolt/src/handlers/commands.ts`, `messages.ts`, `natural-commands.ts` |
| Project provisioning (modal → durable fan-out) | Live | `interactions.ts` (`kit_provision_project`), `src/lib/provisioner/`, `project-control/` |
| Project update / rename ripple (+ Railway recovery) | Live | `src/lib/provisioner/update.ts`; recovery sweep `app.ts` |
| Admin project deletion | Live | `bolt/src/project-deletion/handlers.ts`, `src/lib/project-deletion/` |
| Freelancer onboarding (Slack/Dropbox/Frame.io/Harvest) | **Partial** | `bolt/src/onboarding/` — UX/authz gaps PRD‑2/3/5 |
| Existing-artist assignment (Slack-verified identity) | Live | `bolt/src/onboarding/existing-artist.ts` |
| Offboarding (project-scoped removal) | Live (robust) | `bolt/src/offboarding/`, `src/lib/artist-access/providers.ts` |
| Hours check-ins (scheduled + ad-hoc) + Harvest write | Live | `bolt/src/checkins/*` — scheduled path robust; **ad-hoc double-log PRD‑6** |
| Missing-time monitor / pending nudge | Live | `checkins/missing-time.ts`, `daily-hours.ts` |
| Dropbox→Frame.io delivery + folder share + PM notify | Live | `bolt/src/watchers/dropbox.ts`; Client-Progress vs Delivery labeling correct |
| Delivery-Queue scan + SRT→caption + transcode profiles | Live | `src/lib/inngest/delivery-crons.ts` — **replay duplicate REL‑1**, **full re-list PERF‑2** |
| Storyboard (Boords) + ElevenLabs VO | Live | `src/lib/storyboard/`, `src/lib/inngest/agents/boords.ts`, `src/lib/elevenlabs/` |
| SRT caption QC | Live | `bolt/src/delivery/srt-qc.ts` |
| AE render farm | Implemented / runtime-unverified | `src/lib/delivery/ae-storage.ts`, `kit-deadline-relay/` (Phase-2 deferred) |
| Archive publisher (Dropbox/Vimeo/WordPress/Buffer/Behance) | Partial | `src/lib/archive/`, `kit-behance-worker/` — WordPress/Behance worker unverified |
| RAG / studio knowledge / transcripts / briefings | Live | `src/lib/rag/`, `studio-knowledge/`, `brain/`, `inngest/*-transcripts.ts` |
| Culture Center / memes / birthdays / celebrations | Live | `bolt/src/culture/runner.ts`, `celebrations/`, `src/app/(app)/culture-center/` |
| Control Center dashboard (founder, fail-closed) | Live | `src/app/(app)/control-center/`, `api/control-center/route.ts` (403 w/o access) |
| Project **Brain** `why` / `refresh` | **Partial (Phase-1 stubs)** | `src/lib/inngest/agents/brain.ts:146,152` (PRD‑4) |
| Web app: **Actions / Ask Kit / Render Farm / Settings landing** | **Disabled (dead-end nav)** | render `UnavailableSurface`; linked from nav (PRD‑1) |
| Web app: **Win/Loss, Business Health** | Obsolete | `UnavailableSurface` |
| **Managed-Agents subsystem** (`agents/*.ts`, `managed-agents/*`) | **Dormant / effectively dead** | dispatch route is a 404; webhook-router has no live importer (PERF‑3) |
| Toolkit dispatch/sow/workback/script routes | Disabled (structural 404) | import only `next/server` (invariant 17 — verified) |
| Frame.io browser OAuth callback | Disabled (structural 404) | verified |
| Brain scavenger DM dispatch | Gated off | `app.ts` gated on `KIT_BRAIN_SCAVENGER_ENABLED` |

---

## 3. Coverage matrix

| Area | Inspected | Independently tested/verified | Unverified / blocked |
|---|---|---|---|
| Vercel API routes / webhook auth | ✅ all 16 routes | ✅ fail-closed + timing-safe confirmed; structural 404s confirmed | — |
| MCP auth / tools | ✅ | ✅ token verify path read; tier-from-argument confirmed | Live token issuance (none in prod today) |
| Supabase RLS / SECURITY DEFINER | ✅ baseline + migrations | ✅ advisors pulled (no WARN/ERROR); `match_documents` NULL path confirmed | — |
| Secrets | ✅ tree + git history | ✅ none found; `.env.example` config-only | Production secret *values* (not in scope) |
| Dropbox→Frame.io transfer/integrity | ✅ | ✅ `id@rev` dedup, `verifySourceLink` redirect/SSRF hardening read | **Live Frame.io v4 folder-share contract** (REL‑4) |
| Rename propagation | ✅ | ✅ `move_v2` preserves id/rev; alias produced+consumed | Live cross-service rename run |
| Provisioning idempotency/recovery | ✅ | ✅ ledger + reconcile-by-marker read | `interactions.ts` live paths (no test file) |
| Hours / Harvest | ✅ | ✅ scheduled path CAS+reconcile; ad-hoc double-log confirmed | Live Harvest account |
| Delivery-Queue / Inngest replay | ✅ | ✅ REL‑1 replay defect confirmed at call+helper site | Live Inngest run |
| AI model routing / cost | ✅ | ✅ Opus pin + full map confirmed | Real per-message token spend |
| Migrations | ✅ | ✅ `check-migrations.mjs` PASS; no collisions | Live apply order (fresh vs upgrade) |
| Validation commands | ✅ | ✅ ran vitest/tsc/lint/ratchet/migrations | — |
| DB performance (indexes) | ✅ advisors | ✅ 26 unindexed FK / 106 unused indexes | Query-level EXPLAIN |
| **Railway runtime** | ⚠️ code only | — | **Blocked** — health endpoint proxy-403 |
| Google Sheets workbook / Apps Script | ⚠️ code refs only | env-driven ID confirmed | **Not opened** (no independent Sheets/Apps-Script access this pass) |
| Studio workers runtime | ⚠️ code only | — | Not running in this environment |
| External providers live state (Slack/Dropbox/Frame.io/Harvest) | ⚠️ | — | Not exercised (read-only audit) |

---

## 4. Findings

Severity = user/business/security impact if triggered. Confidence = **Confirmed** (verified in code at `871e0d5`) or **Suspected** (mechanism identified, one dependency unverified). "Latent" = real defect, not reachable today because Kit is single-tenant.

### 4.1 Confirmed findings

#### PERF‑1 — Orchestrator runs on Opus for every Slack turn (cost) · **High (cost) · Confirmed**
- **Where:** `bolt/src/llm/client.ts:26` — `ORCHESTRATOR_MODEL = 'claude-opus-4-7'`; used every turn in `bolt/src/llm/orchestrator.ts:99` (up to `MAX_TURNS=6` tool loops). Specialists already run on Haiku (`client.ts:27`).
- **Root cause / evidence:** The orchestrator's job is to route to specialists and emit ≤1024 tokens, yet it is pinned to the most expensive tier. The module docstring (`orchestrator.ts:9`) explicitly says "Call **Sonnet**" — code contradicts its own stated design.
- **Impact:** Opus is materially more expensive than Sonnet/Haiku per token, paid on the hottest path (every message, up to 6 loops).
- **Smallest durable fix:** set `ORCHESTRATOR_MODEL` to a Sonnet id (matching the docstring) or Haiku; reconcile the design note it cites.
- **Regression test / verify:** Bolt vitest stays green; run a routing-accuracy eval over a sample of real prompts before/after to confirm no quality regression.
- **Rollout/rollback:** one-line, instantly revertible; no migration.

#### REL‑1 — Delivery-Queue notifications re-fire on Inngest replay (duplicate prompts / possible double transcode) · **Medium · Confirmed**
- **Where:** `src/lib/inngest/delivery-crons.ts` — `deliveryDropboxScan` loop (108–209). The SRT branch is correctly wrapped in `step.run('convert-srt-…')` (134–142), but the **non-SRT** `completeDeliveryFileNotification` (202–208) and the caption Slack posts (148–177) run as **raw loop code, outside any step**. Helper `completeDeliveryFileNotification` (53–62) posts **then** marks and never re-reads `notified_at`.
- **Trigger / reproduction:** `newFiles` contains a non-SRT delivery file followed by an SRT file (the common "`movie.mp4` + `movie.srt` dropped together" case). Inngest executes the new `convert-srt` step, then re-invokes the function body from the top; `step.run('scan')` replays from memo (so `movie.mp4` is still in the list), the loop re-runs the non-step post code, and the earlier file is posted to Slack **again**. Also fires on any true retry (`retries:1`) mid-loop.
- **Impact:** duplicate "New delivery file — run `/kit deliver …`" prompts to the project channel; an operator acting on both could start **two transcodes** for one file. Duplicate caption notices. Violates invariants 8 (retry-safe) and 11.
- **Smallest durable fix:** wrap each file's notify+mark in its own `step.run(\`notify-${f.dropbox_id}\`)` (mirroring the SRT branch); do the same for the caption posts. Alternatively re-read `notified_at` immediately before each post.
- **Regression test:** simulate a replay where `newFiles = [nonSrt, srt]` and assert the non-SRT Slack post fires **exactly once** across re-invocations; assert idempotency on a mid-loop retry.

#### PRD‑6 — Ad-hoc hours can double-log to Harvest (duplicate billing) · **Medium · Confirmed**
- **Where:** `bolt/src/checkins/adhoc.ts:146-160` inserts a **new** `daily_hours_checkins` row per ad-hoc message; `bolt/src/checkins/confirm.ts:204-210` builds the Harvest idempotency key as `${checkin.id}:hash(project,task,date,hours,notes)`; `src/lib/harvest/client.ts:517,552` embeds the marker in notes but the **happy-path `POST /time_entries` never pre-checks the marker** — the marker-based `reconcile()` runs only in the `catch` (post-timeout) branch.
- **Trigger / reproduction:** a user sends "4h on Rayfin", ignores the first confirm card, re-sends the identical message, and confirms both cards. Two rows → two distinct `checkin.id` → two distinct markers → two clean POSTs → **two billable Harvest entries**.
- **Why the scheduled path is safe (contrast):** the scheduled check-in has one row per staff/day guarded by a CAS `parsed→logging→logged` transition, so re-confirming the same row can't double-write. The ad-hoc path creates a fresh row per message, so that row-level guard doesn't apply across two messages.
- **Impact:** duplicate billable time; contradicts the "confirmed entries don't produce duplicates" requirement for the ad-hoc surface.
- **Smallest durable fix:** make the Harvest idempotency key **content-addressed** (staff+project+task+date+hours+notes), independent of row id, **and** have the happy-path create reconcile the marker before POST (not only on error). Alternatively, dedupe open ad-hoc rows for the same parsed entry before inserting.
- **Regression test:** two ad-hoc rows with identical parsed entries ⇒ the second confirm creates **0** new Harvest entries.

#### PRD‑5 — CD role passes the onboarding entry gate but is rejected at execution · **Medium · Confirmed**
- **Where:** entry gate `bolt/src/onboarding/permissions.ts:17` `ALLOWED_STAFF_ROLES = ['producer','cd','admin']`; execution gate `bolt/src/onboarding/orchestrator.ts:108` requires `user.tier ∈ ['admin','producer']`; `ROLE_TO_TIER` (`src/lib/inngest/access-control.ts`) has **no `cd`** mapping → defaults to `'artist'`.
- **Trigger:** a user whose only qualifying role is `staff.role='cd'` runs `/kit onboard`, fills the modal, submits → throws *"Onboarding requires producer/admin access."* after the whole flow.
- **Impact:** an explicitly-allowed role completes the entire modal then hits a hard error; onboarding is impossible for CDs. The two gates disagree.
- **Smallest durable fix:** add `cd: 'producer'` to `ROLE_TO_TIER`, or make `runOnboarding` accept the same staff-role union `canOnboard` uses. Fail *before* the modal, not after submit.
- **Regression test:** onboarding authz test with a `cd`-only actor ⇒ `runOnboarding` succeeds (or is refused before the modal).

#### PRD‑2 — Frame.io onboarding message claims a signup link was "sent" when it usually is not · **Medium · Confirmed**
- **Where:** message text `bolt/src/onboarding/services/frameio.ts:119-125`; delivery gate `bolt/src/onboarding/orchestrator.ts:256-302`.
- **Root cause:** the Frame.io signup URL is surfaced only via the welcome DM's `actions[]`, and the welcome is sent **only** when the Slack step returns `ok`. A brand-new freelancer's Slack step returns `failed` (admin guest handoff, `services/slack.ts:154`), so no welcome is sent anywhere — yet the Frame.io result asserts "Self-signup link sent to them in the project channel."
- **Impact:** the producer is told the artist received a signup link; the artist received nothing. Onboarding stalls silently (a "silently fails while reporting success" case).
- **Smallest durable fix:** don't assert delivery in the Frame.io message; surface the signup link to the requester in `buildRequesterSummary`, or post it to the project channel independently of the Slack invite outcome.
- **Regression test:** Slack `failed` + Frame.io `failed(actionUrl)` ⇒ requester summary contains the signup URL and no message claims it was delivered to the artist.

#### PRD‑1 — Web app exposes dead-end navigation pages · **Medium · Confirmed**
- **Where:** `src/app/(app)/app-navigation.tsx:9-17` links to `actions/`, `ask/`, `studio-ops/farm/`, and `settings/` → `settings/workspace/`, all of which render `UnavailableSurface`.
- **Impact:** 3 of 7 primary nav items and the default Settings screen are broken journeys for the only audience (studio leadership); makes the product look half-finished. Live settings sub-pages (team, integrations, etc.) exist but the landing redirect lands on an unavailable page.
- **Smallest durable fix:** remove Actions/Ask/Render-Farm from `links[]` until backed; point the `/settings` redirect at a live sub-page (e.g. `/settings/team`).
- **Regression test:** a nav/route test asserting every `links[]` href renders a non-`UnavailableSurface` component.

#### PERF‑3 — Managed-Agents subsystem is dormant / effectively dead code · **Medium · Confirmed**
- **Where:** top-level `agents/*.ts` (9 definitions) + `src/lib/managed-agents/{webhook-router,session-manager,client}.ts`. Proof of unreachability: the dispatch surface `src/app/api/toolkit/dispatch/route.ts` is a structural 404 whose own comment states it "had no caller at all"; `webhook-router.ts` has **zero live importers**; only `src/app/api/agents/register/route.ts` is live, but with dispatch disabled and the router unwired, registered agents have no in-repo invocation path.
- **Impact:** maintainability — a whole subsystem reads as active but cannot run; it holds the only `claude-opus-4-6` and most `sonnet-4-6` references, inflating the apparent model surface, and it rots.
- **Smallest durable fix:** either finish the wiring (verified caller + workspace-from-identity per invariant 17) **or** quarantine/remove `agents/` + `managed-agents/{webhook-router,session-manager}` + the register route. At minimum, exclude from the "live" model map.
- **Verify:** build/typecheck after removal; confirm no `/api/agents/*` traffic in prod logs.

#### SEC‑1 — MCP agent-action tier is derived from a caller/model-supplied `slack_user_id`, not the signed principal · **Medium (latent; High if a scoped token is issued) · Confirmed**
- **Where:** `src/lib/mcp/tools/agents.ts:44-70` (`kit_list_agents`), `:99-133` (`kit_ask_agent`); tier resolution `src/lib/inngest/access-control.ts:62-107`. The signed principal (`src/lib/mcp/auth.ts`) binds only `workspaceId` + `tools`; the *acting identity* comes from a free-text `slack_user_id` **argument**.
- **Root cause:** whoever can call these tools can pass a founder's Slack id to elevate to `admin` tier and unlock producer/admin-only agent actions and unscrubbed fields (budgets, rates, margins, private-channel history).
- **Why latent today:** `enrichAgentConfig` (`src/lib/managed-agents/agent-registry.ts:10-25`) strips the `kit` MCP toolset from every managed-agent registration, and `createMcpToken` appears only in tests — no production consumer holds a token with these scopes. The Bolt conversational path is safe (it uses the Socket-Mode-verified event user id, not model output).
- **Impact if a token is ever issued:** cross-tier privilege escalation and disclosure of admin-restricted fields to an artist, by changing one argument or via prompt injection.
- **Smallest durable fix:** carry `slack_user_id` (or the resolved tier) **inside the signed MCP token**; ignore any `slack_user_id` in tool arguments; resolve tier from the token.
- **Regression test:** an artist-scoped token that passes a founder's `slack_user_id` to `kit_ask_agent` is still gated at `artist` tier.

#### SEC‑2 — `match_documents` searches all workspaces when `filter_workspace_id` is NULL, and a live caller passes NULL · **Low (latent cross-tenant leak) · Confirmed**
- **Where:** `supabase/migrations/00000000000000_production_schema_baseline.sql` — `match_documents` is `SECURITY DEFINER` with WHERE `(filter_workspace_id is null or pd.workspace_id = filter_workspace_id)`. Live caller `src/lib/brain/retrieve.ts:116-121` passes `workspaceId: opts.workspaceId ?? null`; `searchDocuments` (`src/lib/rag/query.ts:51-58`) requires `visibilityTiers` but **not** `workspaceId`.
- **Verified independently:** the WHERE clause and the null-passing caller both confirmed at the audited commit.
- **Impact:** in any multi-workspace future, RAG/brain retrieval could return another tenant's briefs, budgets, SOWs at the requested visibility tier. Harmless at one workspace.
- **Smallest durable fix:** `raise exception` when `filter_workspace_id` is NULL in the SQL function; make `workspaceId` a required argument of `searchDocuments`.
- **Regression test:** calling `match_documents`/`searchDocuments` with no workspace **errors**, never returns rows spanning >1 workspace.
- **Migration note:** changing the function signature/behavior is a migration; verify no other caller relies on the "all workspaces" behavior first.

#### SEC‑3 — Frame.io short-link resolution follows redirects to arbitrary hosts (blind SSRF) · **Low · Confirmed**
- **Where:** `src/lib/frameio/client.ts:279` (`fetch(shortUrl, { redirect: 'follow' })`) and `:208-217` (`downloadImage(url)` unrestricted fetch); driven from Slack-posted links via `src/lib/frameio/notes-extractor.ts:59,104`.
- **Root cause:** `detectFrameIoLink` constrains only the *initial* host to `frame.io`/`f.io`; `redirect: 'follow'` then chases 3xx to any host (including internal/metadata IPs) with no allowlist or private-IP block. `resolveShortLink` is blind (body not returned), limiting impact; `downloadImage`'s `frame.url` comes from Frame.io's API.
- **Impact:** blind outbound request to an attacker-chosen host from Railway egress (SSRF probe / internal reachability), via a crafted `f.io` link that redirects.
- **Smallest durable fix:** `redirect: 'manual'`, re-validate each hop's host against a Frame.io/Adobe allowlist, reject private/link-local IP literals before fetching.
- **Regression test:** a short link that 302s to `http://169.254.169.254/…` (or any non-allowlisted host) is refused, not fetched.

#### SEC‑4 — `kit_assign_project_access` inserts without a workspace cross-check · **Low (latent) · Confirmed**
- **Where:** `src/lib/mcp/tools/team.ts:44-60` — `db.from('project_access').insert(input)` via the RLS-bypassing admin client; also accepts `can_see_financials`. Individual FKs exist but there is no composite/trigger check that `project_id`, `team_member_id`, and `workspace_id` share one workspace.
- **Impact (latent):** a token for workspace A could grant a workspace-B member access (and financial visibility) to a workspace-B project. Also in the currently-stripped `kit` toolset (see SEC‑1).
- **Smallest durable fix:** verify `project.workspace_id === principal.workspaceId` and `team_member.workspace_id === principal.workspaceId` before insert; add a DB trigger asserting three-way workspace equality on `project_access`.
- **Regression test:** cross-workspace `assignProjectAccess` is rejected.

#### PRD‑3 — Unreachable "Connect pending" welcome branch; new-to-Slack freelancers get no welcome · **Low–Medium · Confirmed**
- **Where:** `bolt/src/onboarding/orchestrator.ts:280` reads `slackInvite.connectPending`, but `bolt/src/onboarding/services/slack.ts` never sets it (declared only on the interface, `:95`).
- **Root cause:** the Slack service was correctly hardened to refuse silent Connect invites, but the orchestrator's channel-post fallback still keys off `connectPending`, now permanently false. The only welcome path is a DM requiring an existing Slack user id, so a not-yet-member freelancer gets neither DM nor channel welcome (compounds PRD‑2).
- **Smallest durable fix:** delete the dead branch, or drive the channel-post path off the actual "admin guest handoff / not-yet-member" signal.
- **Regression test:** a not-yet-member onboarding yields a delivered welcome (channel or requester); no branch depends on `connectPending`.

#### PRD‑4 — `/kit brain why` advertised in help but returns a Phase-1 placeholder · **Low · Confirmed**
- **Where:** `src/lib/inngest/agents/brain.ts:146` (`why` = "[Phase 1 stub]… placeholder"), `:152` (`refresh` no-op); dispatched from `commands.ts:553`, listed in `/kit help` (`:996`).
- **Impact:** producers running `/kit brain why <claim>` get placeholder provenance, not real sources.
- **Smallest durable fix:** mark it explicitly as preview in help + response, or hide the subcommand until provenance lookup ships.

#### PERF‑4 — Invariant 15 falsely claims `interactions.ts` is `@ts-nocheck` · **Medium (doc integrity) · Confirmed**
- **Where:** `.ai/invariants.md` inv. 15 states `bolt/src/handlers/interactions.ts` "is `@ts-nocheck`." The file (3057 lines) has **zero** `@ts-nocheck`/`@ts-ignore`/`@ts-expect-error` and type-checks clean. The only `@ts-nocheck` file in scope is `src/lib/delivery/spec-intake-store.ts`. The "untested" half remains true (no `interactions*.test.ts`).
- **Impact:** an invariant used for debugging asserts a false code fact, eroding trust in the Atlas layer.
- **Smallest durable fix:** drop the `@ts-nocheck` claim (keep the "untested orchestration boundary" caveat); point the `@ts-nocheck` note at `spec-intake-store.ts`.

#### PERF‑2 — `deliveryDropboxScan` re-lists the entire `/Delivery-Queue` tree every minute · **Medium · Confirmed**
- **Where:** `src/lib/inngest/delivery-crons.ts:92` (cron `*/1`) → `scanDeliveryQueue()` → `listDeliveryQueueFiles()` (`src/lib/delivery/dropbox-watcher.ts:34-65`) does a fresh recursive `files/list_folder` with full pagination from scratch each tick — **no persisted delta cursor** (the cursor is a local variable, reseeded every run). The seen-rows *DB* lookup was id-scoped, but the *Dropbox API* enumeration was not.
- **Evidence:** `src/lib/delivery/specs-watcher.ts` (header 13–20) was rewritten to remove this exact "enumerate the entire tree every minute → timeout" anti-pattern via a persisted cursor; this scanner is the older, un-migrated model (still load-bearing for ad-hoc drops + SRT→caption). Violates invariant 7 (work proportional to new activity).
- **Impact:** Dropbox rate-limit consumption and per-tick timeout risk that grows with every file retained under `/Delivery-Queue`.
- **Smallest durable fix:** adopt the specs-watcher pattern — seed once via `list_folder/get_latest_cursor`, persist the cursor, poll `list_folder/continue`.
- **Regression test:** Dropbox call count is flat as queue size grows (specs-watcher tests are the template).

### 4.2 Suspected risks (mechanism identified, one dependency unverified)

#### REL‑4 — Folder-level Frame.io "review link" relies on unverified v4 folder-as-asset behavior, and the share is public · **Medium (product) / Low (security) · Suspected**
- **Where:** `bolt/src/watchers/dropbox.ts:854` (`ensureFrameioFolderShare`) → `:802` (`buildFrameioShareRequest`) posts `{ data: { type:'asset', access:'public', asset_ids:[folderId] } }` — i.e. it shares a **folder id** through the per-asset `asset_ids` field, and the contract test only asserts request shape, not the live API response.
- **Risk:** if Frame.io v4 does not treat a folder id passed via `asset_ids` as a folder share, producers get a broken or single-asset link while the code reports success (a "mock conceals provider-contract" case the audit brief warns about). Separately, `access:'public'` means anyone with the (unguessable) URL can view client deliverables, and that URL is posted into Slack.
- **Smallest durable fix:** add a live/staging contract test that shares a real folder and asserts a folder-scoped review URL; confirm `access:'public'` is the intended sharing model for client deliverables (vs. authenticated review).
- **Could not verify:** live Frame.io v4 response (read-only audit; no mutation against the production account).

#### REL‑2 — `deliveryJobNotifier` first-message crash window → duplicate job message · **Low–Medium · Suspected**
- **Where:** `src/lib/inngest/delivery-crons.ts:276-296` — the initial `slackPost` (278) happens before the `render_jobs` UPDATE storing `slack_message_ts` (280–287), whose error is unchecked, with no `step.run`.
- **Risk:** if the post succeeds but the DB write fails/interrupts, `slack_message_ts` stays null and the next tick re-posts a new message instead of editing in place (terminal states are guarded, the first post is not).
- **Fix:** check the UPDATE error; conditional write `…is('slack_message_ts', null)`; ideally wrap post+persist in a durable step keyed on job id + status.

#### PRD‑7 — `resolveWorkspaceId` falls back to the first workspace on team mismatch · **Low (latent) · Suspected**
- **Where:** `bolt/src/handlers/messages.ts:1127-1134` — on a `slack_team_id` miss, selects `.from('workspaces').select('id').limit(1)`.
- **Risk:** harmless at one workspace (corroborated: production has exactly 1), but a second workspace/Slack Connect team would cross-wire user context, project resolution, and participation to whichever workspace is row #1; also masks a genuine misconfiguration.
- **Fix:** fail closed (return empty + log) on mismatch; use an explicit `KIT_DEFAULT_WORKSPACE_ID` opt-in for the single-tenant case.

#### PERF‑7 — `deliveryJobNotifier` 50-row window includes already-notified terminal rows · **Low · Suspected**
- **Where:** `src/lib/inngest/delivery-crons.ts:256-264` selects `status IN (claimed,processing,complete,failed) ORDER BY updated_at DESC LIMIT 50`, then skips terminal-already-notified rows in JS. Under a burst of completions, a genuinely-new active job could be starved for a tick. Self-healing.
- **Fix:** filter in SQL (exclude `slack_notified_status = status` for terminal states, or split active vs terminal queries).

#### PERF‑8 — Nightly summary metadata scans are workspace-wide/unbounded · **Low · Suspected**
- **Where:** `src/lib/studio-knowledge/auto-summarize.ts:185-189` fetches **all** summary/note/transcript `project_documents`, `:204-207` all suggested/pending/approved `kit_actions`, every nightly run. The expensive Haiku+embedding work is correctly change-gated, so impact is a growing metadata read.
- **Fix:** bound the reads to a recent window or paginate.

### 4.3 Improvement suggestions (maintainability / hygiene — not defects)

- **PERF‑9 — Duplicated ad-hoc Slack helpers.** `slackPost`/`slackUpdate` (`delivery-crons.ts:31,64`), `postFromInngest` (`brain-crons.ts:19`), plus a third direct caller bypass the shared `src/lib/mcp/slack.ts` (minor drift from invariants 3/13). Consolidate.
- **PERF‑10 — `bolt/` typecheck is not self-contained.** `npx tsc --noEmit` in `bolt/` emits ~15 phantom "Cannot find module" errors on a fresh checkout until **root** `node_modules` is installed (the `@lib/*` alias resolves against root deps). `.ai/validation.md` should note the prerequisite.
- **PERF‑5 / PERF‑6 — Stale Atlas docs.** The "032–035 migration prefix collision" warning in `.ai/audits/architecture.md` §2 and `.ai/repo-map.md` is **stale** — migrations are now timestamp-prefixed with no collisions (`check-migrations.mjs` PASS, 118 files). The `delivery-crons.ts` header says "30s/60s" but all crons are `*/1`. Correct both.
- **LINT — Baselined lint debt.** Raw `npm run lint` fails with **1346 problems (1259 errors, 87 warnings)**, overwhelmingly `@typescript-eslint/no-explicit-any`. `lint:ratchet` passes because 1259 errors are baselined in `config/eslint-debt-baseline.json`. The gate prevents *new* debt but a large stock remains — a passing ratchet is not a clean codebase. Chip down the baseline over time.
- **DB‑1 — 26 unindexed foreign keys** (mostly composite `*_workspace_project_fkey`), per Supabase performance advisors. Add covering indexes on the composite FK columns actually used in joins/filters.
- **DB‑2 — 106 unused indexes** (many single-column `idx_*_workspace`) — write amplification + storage with no read benefit (no selectivity at one workspace). Drop the unused ones (or defer until multi-workspace is real). Strong corroboration of the single-tenant reality.
- **SEC‑5 (S1) — `/api/internal/studio-worker` actions are not workspace-scoped** (e.g. `render.get_job` returns `select('*')` for any job id). Acceptable for a single-studio farm behind a ≥32-char shared secret (fail-closed), but the render/worker tables carry no tenant boundary — the secret is the only isolation. Revisit if the farm becomes multi-tenant.
- **SEC‑6 (S2) — Partial Slack token suffixes logged at startup** (`bolt/src/app.ts:595-596`, last 6 chars). Low value to an attacker; consider dropping.
- **Config risk — legacy project-control workbook via env.** `PROJECT_CONTROL_LEGACY_SPREADSHEET_ID` + `PROJECT_CONTROL_LEGACY_MIGRATION_ENABLED` machinery exists. The deprecated workbook id is **not hardcoded anywhere**, but confirm this env var is unset (or not pointed at `1K‑P4yCU…`) in production — not verifiable from this environment.

### 4.4 Verified-correct (explicitly checked; no action needed)

- **No secrets** in tracked files or git history; `.env.example` is config-only. `npm audit --production` = **0 vulnerabilities**. CSP hardened (`strict-dynamic` nonce, `frame-ancestors 'none'`, `object-src 'none'`).
- **Webhook/route auth is verify-before-side-effect and fail-closed:** MCP `checkMcpAuth`, sheet-edit `authorizeSheetEditWebhook` (HMAC + replay window + exact workbook match + zero Inngest sends on denial), studio-worker (≥32-char secret), agent-registration, and Dropbox HMAC all deny on missing config and use `timingSafeEqual`. Toolkit + OAuth-callback routes are structural 404s that never read the body. MCP path-key route is a hard reject.
- **RLS on all tables; no WARN/ERROR security advisories.** The 10 `rls_enabled_no_policy` tables are deliberate deny-all service-role-only tables (grants revoked). All SECURITY DEFINER functions pin `search_path`; `match_documents` is granted to `service_role` only.
- **Rename propagation is safe:** Dropbox rename uses `move_v2` (preserves file id + rev), the old safe-name is retained as an alias and consumed by `lookupDropboxProject`, and the `(project_id, dropbox_file_id, dropbox_rev)` transfer ledger blocks historical re-uploads. **Folder renames cannot fabricate new revisions.**
- **Media byte integrity:** `verifySourceLink` does a real GET (not HEAD), manual-redirect-bounded to `*.dropboxusercontent.com`, with range/length/type/encoding checks and always cancels the stream; `frameFileReadiness` requires exact `file_size` + transcoded status.
- **Scheduled hours path** is CAS-guarded with post-timeout reconcile; reminders are suppressed for logged entries; missing-time alerts are idempotent per streak.
- **Offboarding scoping** removes only the one project's channel/folder/Frame.io project and the project-scoped `project_access` row; refuses inherited/group/owner access; Harvest bucket retained.
- **Sync incident alerting** only fires after ≥3 failures **and** ≥5 minutes, one alert per incident, private-DM-only (fail-closed, HTML-escaped), retaining no raw provider data — a genuinely good anti-false-alarm design.
- **Migration discipline** is sound: squashed baseline + `baseline-migration-ledger.json` + `check-migrations.mjs` integrity check; old numbered files kept as immutable no-op markers; no duplicate timestamps.
- **Bolt test suite:** 961 tests pass, 0 fail, no `.skip`/`.todo`.

---

## 5. Prioritized remediation plan

### Immediate (this week)
1. **PERF‑1** — repoint `ORCHESTRATOR_MODEL` to Sonnet/Haiku after a quick routing eval. *(cost)*
2. **REL‑1** — wrap Delivery-Queue non-SRT notify+mark and caption posts in per-file `step.run`. *(duplicate action / double transcode)*
3. **PRD‑6** — content-address the Harvest idempotency key + pre-POST reconcile. *(duplicate billing)*
4. **PRD‑5** — add `cd → producer` tier mapping (or unify the two gates). *(broken onboarding for CDs)*
5. **PRD‑2 / PRD‑3** — stop claiming the Frame.io signup link was "sent"; deliver the link to the requester/channel when the Slack invite fails; remove the dead `connectPending` branch. *(silent onboarding stall)*
6. **PRD‑1** — remove the three dead-end nav links + fix the Settings redirect. *(broken UX for leadership)*

### Next week
7. **SEC‑2** — make `match_documents`/`searchDocuments` require a workspace (raise on NULL). *(latent tenant leak)*
8. **SEC‑1** — bind the acting identity into the signed MCP token; stop trusting `slack_user_id` arguments. *(latent privilege escalation)*
9. **SEC‑3** — Frame.io short-link fetch: `redirect:'manual'` + host allowlist + private-IP block. *(SSRF)*
10. **PERF‑2** — migrate `deliveryDropboxScan` to a persisted Dropbox cursor. *(quota/timeout scaling)*
11. **REL‑2 / PERF‑7** — harden `deliveryJobNotifier` (check UPDATE error, conditional ts write, SQL-side terminal filter).
12. **PERF‑4 / PERF‑5 / PERF‑6** — correct the stale Atlas docs (invariant 15, migration-collision, cron cadence).

### Later (backlog)
13. **PERF‑3** — finish-or-quarantine the Managed-Agents subsystem.
14. **SEC‑4 / PRD‑7** — workspace cross-checks + fail-closed workspace resolution (do before any second workspace ships).
15. **DB‑1 / DB‑2** — add composite-FK covering indexes; drop unused indexes.
16. **PERF‑8 / PERF‑9 / PERF‑10 / LINT** — bound nightly scans, consolidate Slack helpers, document the bolt typecheck prerequisite, chip down lint debt.
17. **REL‑4** — add a live Frame.io folder-share contract test; confirm the public-link sharing model.

---

## 6. Feature recommendations (grounded in how the studio works)

Each: value · effort · dependencies · tradeoffs.

1. **Onboarding delivery receipts.** After PRD‑2/3, have Kit post a single truthful onboarding summary to the requester listing exactly what each service did and any pending human handoff (Slack guest invite still needed, Frame.io signup link here). *Value: high (kills silent stalls). Effort: low. Deps: PRD‑2/3. Tradeoff: none.*
2. **Ad-hoc hours "already logged" guard in the UI.** When a matching open ad-hoc entry exists, show "You already have an unconfirmed 4h on Rayfin — confirm that one?" instead of creating a second card. *Value: high (billing integrity, complements PRD‑6). Effort: low–med. Deps: PRD‑6.*
3. **Delivery review-link dashboard.** Since 259 projects flow through `09_Outgoing`, a `/status`-style page listing each project's latest Client-Progress and Delivery folder share URLs (from `frameio_folder_shares`) would save producers hunting in Slack scrollback. *Value: med-high. Effort: med. Deps: existing table. Tradeoff: must respect the public-link exposure question in REL‑4.*
4. **Cost/observability panel for AI usage.** Given PERF‑1/3, a small per-model call/token counter (even log-derived) would let the studio see inference spend and catch regressions. *Value: med. Effort: med. Deps: none.*
5. **Second-workspace readiness checklist.** If Slack Connect / a second brand is ever on the roadmap, treat SEC‑1/2/4 + PRD‑7 as the gating list. *Value: high if it happens, zero if not. Effort: the fixes above. Tradeoff: don't over-invest while single-tenant.*
6. **Index right-sizing pass.** Drop the 106 unused indexes and add covering composite-FK indexes in one migration once query patterns are confirmed with `EXPLAIN`. *Value: med (write throughput + storage). Effort: low-med. Deps: DB‑1/2.*

---

## 7. Plain-English summary (for the studio owner)

Kit is in good shape. It has clearly been built and hardened carefully: there are no leaked passwords, no known-vulnerable libraries, the web dashboard is locked down, and the trickiest parts — moving files from Dropbox to Frame.io, renaming projects across every tool, and logging hours to Harvest — are built to survive crashes and retries without losing or duplicating work. The version running on the website (Vercel) is exactly the latest code. (I couldn't reach the always-on Slack bot's server, Railway, from where I ran this, so I checked its code but not its live version.)

There are a handful of real things worth fixing, none of them a five-alarm fire:

- **You're probably overpaying for AI.** The main Slack "brain" that decides what to do runs on the most expensive model on every single message, even though the code's own notes say it should use a cheaper one. Switching it is a one-line change and the biggest easy saving.
- **A few things can quietly duplicate.** In one case, logging hours by just typing them (not the scheduled prompt) can bill the same time twice if you send it twice. In another, a delivery file dropped alongside its caption file can send the "new delivery" Slack prompt twice — and someone could kick off two conversions. Both are fixable and low-risk to fix.
- **Onboarding a brand-new freelancer can quietly stall.** Kit sometimes says it "sent" the person a Frame.io signup link when it actually didn't send them anything. And a "CD" role is allowed to start onboarding but gets rejected at the end. These make it look like onboarding worked when it didn't.
- **The web app has some dead buttons.** A few menu items (Actions, Ask Kit, Render Farm, and the default Settings screen) lead to "not available" pages. Hiding them until they're ready would make the app feel finished.
- **Some safeguards for "multiple companies" aren't fully wired.** Today you have exactly one workspace, so this doesn't affect you. But if you ever add a second brand or a client's Slack, a few places would need tightening first — I've listed them.

Bottom line: fix the AI cost, the two "duplicate" bugs, and the onboarding messages first; everything else is tidy-up. I'd resolve these before piling on new features.

---

## 8. Closing questions answered

- **What could lose data, expose information, grant incorrect access, or duplicate actions?**
  Duplicate *actions*: PRD‑6 (double Harvest billing), REL‑1 (duplicate delivery prompt / possible double transcode), REL‑2/REL‑3 (duplicate job/share messages on crash windows). Incorrect *access*/exposure: all **latent** at one workspace — SEC‑1 (tier from caller-supplied id), SEC‑2 (`match_documents` NULL → cross-workspace), SEC‑4 (`project_access` no workspace check), PRD‑7 (first-workspace fallback). Exposure via public link: REL‑4 (`access:'public'` folder shares). No data-loss path was found — provisioning, delivery, and hours all use durable ledgers/reconcile.
- **What can silently fail while Kit reports success?**
  PRD‑2 (onboarding says the signup link was sent when it wasn't), PRD‑3 (new-to-Slack freelancer gets no welcome), REL‑4 (folder share reported successful though the live Frame.io folder-share contract is unverified), PRD‑4 (`/kit brain why` returns a placeholder while advertised as working).
- **What could generate recurring false alarms or unnecessary cost?**
  Cost: PERF‑1 (Opus on every turn), PERF‑2 (per-minute full `/Delivery-Queue` re-list consuming Dropbox quota), PERF‑8 (unbounded nightly scans). False alarms: notably *well-controlled* — the sync-incident alerting is a model of restraint; REL‑2/PERF‑7 are the only residual duplicate-message risks.
- **Which previous fixes are incomplete or brittle?**
  PR #192's media-integrity + rename-alias work is solid and correctly consumed. The **incomplete** ones are onboarding-adjacent: PRD‑3 (the Slack service was hardened but left a dead `connectPending` branch, so the intended channel-welcome fallback never fires) and PRD‑2 (message text not updated to match the new failure behavior). The Delivery-Queue scanner is the *older* pattern the specs-watcher already superseded (PERF‑2/REL‑1).
- **What should be fixed before adding more features?**
  The Immediate list in §5: orchestrator cost, the two duplicate paths (Harvest + delivery), and the onboarding truthfulness/authorization gaps.
- **What could not be verified?**
  Railway's deployed revision and live `/health` (proxy-blocked); the live Frame.io v4 folder-share contract (REL‑4, no production mutation); the Google Sheets workbook contents / Apps Script / triggers (not independently opened this pass); real per-message AI spend; the production value of `PROJECT_CONTROL_LEGACY_SPREADSHEET_ID`; and the studio workers' running state.

---

## 9. Addendum — live production verification (2026-09-24, read-only)

After the initial report, two coverage gaps flagged as central to the studio's actual pain — the **live Railway bot** and the **Google Sheet / Apps Script** — were partially closed using read-only production access (Supabase `system_health`/`cron_heartbeats`/ledger tables via MCP, and the Drive connector for the workbook). Findings below are **authoritative live data**, timestamped ~13:10–13:15 UTC on 2026-09-24. Railway's HTTP `/health` remained proxy-blocked from the audit environment, so Railway process liveness is inferred, not directly probed.

### 9.1 Live health snapshot (from `public.system_health`, watchdog ran ~3 min before capture)
- **All external providers UP right now:** Dropbox 142 ms, Frame.io 80 ms, Harvest 67 ms, Google 279 ms, Supabase 1892 ms (slow but up), `control-outbox` clear ("no overdue or unconfirmed control requests").
- **All 5 Vercel/Inngest crons fresh** (`cron_heartbeats`): delivery-dropbox-scan & delivery-specs-scan <1 min, plaud 8 min, pre-meeting 14 min, drive-transcript 14 min. **The Vercel/Inngest plane is healthy.**
- **Production scale reconfirmed:** 259 projects, 32 project-control bindings, **0 open sync incidents**.

### 9.2 New confirmed findings

#### LIVE‑1 — No liveness telemetry for any Railway cron (observability blind spot) · **Medium–High · Confirmed**
- **Evidence:** `recordCronSuccess(...)` is called by exactly 5 ids, **all Vercel/Inngest** (`delivery-dropbox-scan`, `delivery-specs-scan`, `drive-transcript-scan`, `plaud-transcript-scan`, `pre-meeting-scan`); `grep` for `recordCronSuccess`/`cron_heartbeats` in `bolt/src` returns **nothing**. So none of Railway's node-cron jobs — 09:00 pending-check-in nudges, missing-time scan, hourly delivery, hourly brain-approval, every-minute AE completion notifier, 5-minute project create/update recovery sweep, Friday timesheet meme, daily celebrations — writes a heartbeat or a `system_health` row.
- **Impact:** the `/status` dashboard and the health watchdog cannot tell you if a Railway scheduled job has silently stalled. Given the studio's problems center on the always-on Slack bot, **the one runtime most likely to hurt you is the one with no monitoring.** A stalled recovery sweep (stranded provisioning) or missing-time scan would be invisible until a human noticed the missing behavior.
- **Smallest durable fix:** have each Railway node-cron call the existing `recordCronSuccess(<id>)` on success; add `cron:<railway-id>` staleness rows to the watchdog with per-cron expected-interval thresholds.
- **Why this matters most:** it is the direct remedy for "we can't tell when the bot breaks."

#### LIVE‑2 — A real delivery has been stuck in "manual review" ~40 h (integrity guard working; no operator resolution) · **Medium · Confirmed (live)**
- **Evidence:** `system_health.dropbox-inbox` = **DOWN since 2026-09-22 22:00 UTC**, detail: *"frameio_delivery requires manual review: Upload integrity: `01_East_Landscape_JK_Tonight_2016(w) x 678(h)_083126.mov` was served as application/json, not the expected media."*
- **Interpretation:** this is PR #192's `verifySourceLink`/`frameFileReadiness` guard **working exactly as designed** — it detected that Dropbox served a JSON (error/HTML) body instead of media and **refused to upload garbage to Frame.io**. That is the correct, safe outcome and validates the recent hardening. **But** the delivery has now sat unresolved for ~40 h, surfacing only as a persistent aggregate health "down" with no per-item operator action path.
- **Impact:** a genuine client deliverable is stuck, and the only signal is a red dot on `/status` that a human must notice and manually chase; it also keeps `dropbox-inbox` red, desensitizing the team to that indicator.
- **Smallest durable fix:** turn "manual review" items into an actionable, addressable queue (Slack DM to the producer / a `/kit delivery review` list) with the file, the reason, and a retry/skip control — rather than a single rolled-up health status.

#### LIVE‑3 — 56 Frame.io delivery transfers orphaned in `processing`, far past the 24 h timeout · **Medium · Suspected (live data + mechanism)**
- **Evidence:** `frameio_delivery_transfers` states — `ready` 100, **`processing` 56 (oldest ≈ 569 h / 23.7 days)**, `failed` 16. The table's only states are `processing`/`ready`/`failed` (migration `20260831024500`); `ready` is the terminal success state. A 24 h guard exists (`FRAMEIO_PROCESSING_TIMEOUT_MS`, `shouldTimeoutFrameioProcessing`, `dropbox.ts:1710-1721`) that throws "exceeded 24-hour processing window" — **but only when the inbox re-drives that transfer.** Rows whose owning inbox event is no longer being retried are never re-evaluated, so they sit in `processing` indefinitely.
- **Why Suspected not Confirmed:** some of the 56 may be **intentionally-abandoned superseded revisions** (`deferFrameioProcessing`, "Dropbox source changed; waiting for its durable successor") rather than true orphans; disambiguating needs per-row triage I did not perform (read-only, no mutation).
- **Impact:** a tail of deliveries that may never complete or fail — silent stuck work, invisible except in aggregate. Directly matches the audit's "what can silently fail while Kit reports success" question.
- **Smallest durable fix:** add a stale-`processing` sweep (there is already a partial index `where state = 'processing'`) that applies the 24 h timeout independent of inbox retries — moving genuinely stale rows to `failed` with a reason, and explicitly closing superseded ones. Then alert on `failed` count deltas.

### 9.3 Railway process liveness — best-effort conclusion
- **Positive signals:** `control-outbox` health is UP with no overdue/unconfirmed requests (Railway drains this outbox; nothing is stuck — 14 rows, all `sent`); `daily_hours_checkins` shows a scheduled write ~13 h ago (last night); no open sync incidents. The Slack-connectivity `/health` endpoint that Railway serves is the watchdog's basis and nothing indicates a Slack outage.
- **Limits:** I could **not** directly confirm Railway is up *at capture time* — its `/health` is proxy-blocked here, its crons emit no heartbeat (LIVE‑1), and its DB writes are event-driven and sparse, so a multi-hour Railway outage during a quiet window would not necessarily show in the data. **Conclusion: Railway was demonstrably doing scheduled work last night and shows no stuck-work symptoms, but there is no positive proof it is running right now — which is itself the point of LIVE‑1.**

### 9.4 Google Sheet / Apps Script — what was and wasn't verified
- **Verified (live, via Drive connector):** the authoritative workbook `1qF690…AXeGyo` ("R&F Production Control Center") is owned by `steve@rangerandfox.tv`, was **modified 2026-09-24**, and its **Control Center** and **Projects** tabs match the code's model (Projects = one authoritative row per project; canvases described in-sheet as "generated views"). Project identity in the sheet (e.g. 2642 CS Teams, 2636 CCAI, 2637, 2633, 2639, 2625, 2631) is current and consistent with the Supabase project set. The sheet embeds **OneDrive/SharePoint links** (scripts, folders) — a Microsoft-365 surface worth confirming Kit handles or ignores deliberately. **Deprecated workbook `1K‑P4yCU…` is not referenced** in the live sheet's visible content.
- **Sync coverage:** only **32 of 259 projects** carry a project-control binding (Sheet row ↔ Slack Canvas). This is consistent with binding being scoped to active projects, but confirm that is intentional — 227 projects have no managed Canvas.
- **Could NOT verify (tooling gap, not a clean bill):** the bound **Apps Script** project — its source, triggers, and the exact payload/HMAC it posts to `/api/webhooks/project-control/sheet-edited` — is **not readable through any connector available in this session** (the Drive connector exposes the spreadsheet, not its bound script; there is no Apps Script API tool). The sheet-edit webhook's *receiver* is verified (fail-closed HMAC, replay window), but the *sender* (Apps Script) remains unverified. Validation lists, cell-level protections, and hidden filters were likewise not enumerated this pass. **This is the largest remaining genuine gap** and should be closed by opening the Apps Script editor directly (Extensions → Apps Script) and reviewing its triggers + the secret it signs with.

### 9.5 Updated coverage — what still can't be verified
- Railway **process** liveness in real time and its per-cron execution (blocked: proxy + no telemetry → see LIVE‑1).
- Apps Script source/triggers and the Sheet's validation/protection layer (no tool access this session).
- Live Frame.io v4 folder-share contract (REL‑4) and real per-message AI spend (no mutation / no billing access).
- Per-row triage of the 56 `processing` transfers (LIVE‑3) to separate true orphans from superseded revisions.

### 9.6 Follow-up work done on this branch (post-audit, at maintainer's request)

Two of the above were taken further than assessment. Both are on the audit branch only — **not merged, not deployed.**

**LIVE‑1 heartbeat wiring — drafted + tested.** Railway's frequent node-cron jobs now stamp `cron_heartbeats` on success so the existing Vercel watchdog surfaces them on `/status`:
- New helper `bolt/src/cron-heartbeat.ts` (`stampCron(id)`, best-effort, never throws into the cron).
- `stampCron` wired into: `dropbox-inbox-sweep`, `project-share-recovery`, `project-control-recovery`, `missed-checkin-reply-recovery`, `ae-render-notify`, `behance-elevenlabs-sync`, `frameio-project-link-reconcile`, `daily-hours-reminder` (all in `bolt/src/app.ts`).
- Registered in `src/lib/health/probes.ts` (`CRON_MAX_AGE_MIN` + `CRON_LABELS`) with per-cron staleness thresholds; a new `freshness.test.ts` case asserts a stalled `dropbox-inbox-sweep` goes red.
- **Validated:** root + bolt `tsc` clean; bolt vitest **961 pass**; cron-freshness suite **5 pass**.
- **Deliberately left for a follow-up:** the weekday/daily 9am crons (pending-checkin nudge, missing-time scan, celebrations, timesheet meme, Last-Share backfill) are *not* auto-checked, because a naive max-age false-reds on weekends — they need schedule-aware freshness. They can adopt the same one-line `stampCron` once that lands.
- **Rollout note:** deploy the Railway (Bolt) change **before or with** the `probes.ts` change; the watchdog marks a registered cron red until its first heartbeat, so enabling the checks before Railway ships would show a transient red.

**LIVE‑3 triage data (read-only, for whoever clears the queue).** The 56 `processing` rows break down as:

| Provider status | Count | Stale >7 days | Meaning |
|---|---|---|---|
| `created` | 31 | 31 | Frame.io asset created, upload never advanced |
| `pending` | 22 | 8 | Remote upload initiated, ~13 genuinely in-flight/recent |
| (none) | 3 | 3 | Never got a provider status |

Concentrated in a burst ~23 days ago in two now-closed projects — **2639 (Jimmy Kimmel pitch): 28 stuck; 2637 (Microsoft): 11; 2625 (Azure): 3; 2629: 1.** These projects have since wrapped/delivered, so the rows are almost certainly reconcilable ledger orphans rather than un-shared client media — but they should be triaged individually (a per-row check of `frameio_file_id` + the actual Frame.io asset state) before the recommended stale-`processing` sweep is enabled, so a genuinely-incomplete delivery isn't silently marked `failed`.

**Net for the reader:** the initial verdict stands and is reinforced — Kit's Vercel plane and integrations are healthy and its recent integrity hardening demonstrably works in production (LIVE‑2). The additions here are: a concrete **observability gap on the exact runtime you've been burned by** (LIVE‑1), a **live stuck delivery** and a **tail of orphaned transfers** to clear (LIVE‑2/3), and an honest marker that **Apps Script remains the one piece I could not open**. Treat LIVE‑1 as the highest-leverage fix for "we can't tell when the bot breaks."

---

*Prepared as an independent, read-only assessment. No production systems, records, credentials, or external content were modified — all production access was read-only (Supabase SELECTs, Drive read, Vercel/Supabase advisories). No fixes were implemented — this is the assessment and plan.*
