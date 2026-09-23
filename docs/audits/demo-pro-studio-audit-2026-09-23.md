# Demo Pro Studio — Independent Backend, Security, Reliability, Scale and Cost Audit

**Date:** 2026-09-23
**Auditor:** Claude (independent second review, read-only)
**Audited production commit:** `d6398174d34e273d65e4e096eb49b8474e65ab53` (branch `main`) — confirmed as the live production deployment `dpl_3Z4VPpUG5iThK58cDCeBrguoCqx4` serving `demopro.studio` (Vercel, region `iad1`, Next.js 16.3.4, Node 22.x, Pro plan). The response HTML of `https://demopro.studio/` carries `data-dpl-id="dpl_3Z4VPpUG5iThK58cDCeBrguoCqx4"`, so main HEAD and production are the same commit.
**Draft reviewed separately:** PR #30, branch `fix/recorder-handoff-audio-2026-09-22`, commit `5ea7206424efe414814bf3f99773a7f4b1adcdd0`, built as preview `dpl_7DfGy5ycGWz4eXLM7sKYbQBNADbu` (not production).
**Database state observed:** Supabase project `vxohvyuelphxytkzvzgk` (us-east-1, Postgres 17.6), read-only SQL on 2026-09-23.

---

## 0. Read this first: what this audit could and could not inspect

This session had **no access to the `steve-rangerandfox/demo-pro` source repository**. The Claude Code session was started from the `RangerAndFox/Kit` repository, and the platform refuses to attach a repository from a different GitHub owner to a session that already holds one (`add_repo` gate `cross_tier`). The repository is also not in the list of repositories this Claude account can reach, and the GitHub connector is scoped to `rangerandfox/kit`. So:

- **Not reviewed:** any TypeScript/Swift source (`src/app/api/*`, `src/proxy.ts`, `src/lib/**`, `desktop/recorder-macos/**`), `package.json`, the lockfile, CI workflows, migrations as files, tests, or the docs listed in the brief. Findings that depend on route-handler behaviour are marked **"needs code confirmation"**.
- **Not run:** `npm ci`, `npm run gate`, `npm run test:rls`. The 2,527 unit / 63 visual / 569 e2e counts are reported by you and were not reproduced.
- **Reviewed with direct evidence:** the live Supabase database (schema, every RLS policy, every function body, grants, triggers, constraints, indexes, row counts, storage bucket, role settings, 24 h logs), the Vercel project (deployments, environment variable *names*, domains, protection settings, firewall config, build logs for both commits, 24 h runtime logs), black-box HTTP behaviour of production, and official platform documentation for limits and pricing.

Because the schema, RLS, grants, admission functions, and deployment configuration are the actual security and durability boundary of this system, the evidence-backed findings below are substantive. But the verdict is **provisional until a code pass is done**. To unblock a code pass: start a **new** Claude Code session with `steve-rangerandfox/demo-pro` as the initial repository (or connect GitHub for that owner at https://claude.ai/connect-github and install the Claude GitHub App on the repo), then run the "code-confirmation checklist" in §11.

---

## 1. Readiness verdict

| Stage | Verdict | Why (one line each) |
|---|---|---|
| **Current two-user private beta** | **Acceptable, with two fixes this week** | DB-level gating is genuinely fail-closed (§3, F4); but a beta user can insert `render_jobs` rows directly and bypass export admission (F1), and there is no error monitoring or budget alarm at all (F6). |
| **Public launch (self-serve individuals)** | **Not ready** | Hard-coded allowlist in SQL (F4), storage lifecycle/quota ledger switched off in production (F2), narration limited to 2 concurrent jobs globally and a 1,000-row usage table (F5), no observability or tested restore (F6/F7), billing routes deployed without any billing configuration (F8), render worker absent (F3). |
| **Enterprise deployment (500-seat customers)** | **Not ready; several quarters of work** | No multi-user workspaces (no invitation or membership path exists at the DB level), no SSO/SCIM/audit trail/retention controls, smallest Supabase compute tier (60 direct connections, 200 pooler clients), single region, storage backups do not include objects, no data-deletion workflow. |

**What is good and should be kept:** all business-critical admission logic (project creation, render enqueue/claim/finish, narration reserve/charge/dispatch/finish, storage reservations) lives in Postgres functions with `search_path=''`, `READ COMMITTED` guards, row locks, idempotent replays, and fencing tokens. Private tables live in a `demo_private` schema with no grants to `anon`/`authenticated`. The storage bucket is private with no client-side `storage.objects` policies, so all media access is server-mediated. Preview deployments require Vercel SSO. Security headers on production are strong (HSTS 2 years, `frame-ancestors 'none'`, nosniff, `X-Frame-Options: DENY`, `robots.txt` disallow-all). This is a far better foundation than most beta products.

---

## 2. Actual architecture and service map (evidence-based)

Legend: **ACTIVE** = observed in production. **INACTIVE** = code/schema exists, no configuration or rows. **PROPOSED** = only in plans. **UNVERIFIED** = could not confirm from this session.

| Component | Status | Evidence |
|---|---|---|
| Vercel project `demo-pro` (prj_N6n9WpHUPiw37tXd5NOfijNvuSXi), team `steve-rangerandfoxs-projects` (Pro plan) | ACTIVE | `get_project`, `get_git_deployment_context` |
| Production domain `demopro.studio` (+ 3 `*.vercel.app` aliases), single region `iad1`, Node 22.x | ACTIVE | deployment object |
| Preview protection: Vercel SSO on all non-custom domains; no password protection on production | ACTIVE | `ssoProtection.deploymentType = all_except_custom_domains` |
| Vercel Firewall custom rules / rate limits | **NOT CONFIGURED** | `get_firewall_config(active)` → "Seawall Config not found" (platform defaults only) |
| Vercel production env vars (names only) | ACTIVE | exactly 5: `ELEVENLABS_API_KEY` (sensitive; comment: "TTS, STT, Voices Read only; 10,000 credits per refresh period"), `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Supabase Auth, Google OAuth only | ACTIVE | 2 users, 2 `google` identities, 0 other providers; login page offers only "Continue with Google" |
| Supabase Postgres via **PostgREST** from the browser (reads) and service role from the server (writes/RPC) | ACTIVE | 24 h edge logs: browser JWT (`role=authenticated`) GETs on `/rest/v1/workspace_members`, `/rest/v1/projects`, `/rest/v1/assets`, `/rest/v1/render_jobs`; all storage `sign` calls carry no user JWT (service role). No `DATABASE_URL` env var → no direct Postgres driver in production. |
| Drizzle schema / SQL migrations | ACTIVE (21 migrations applied 2026-09-14 and 2026-09-18) | `list_migrations` |
| Supabase Storage bucket `demo-pro-private` (private, 500 MB per-object limit, no MIME allow-list) | ACTIVE | `storage.buckets`; 236 objects, 413 MB, all `owner_id` null (service-role writes) |
| **Storage lifecycle ledger** (`demo_private.storage_objects`, reservations, cleanup leases, inventory) | **INACTIVE** | `demo_private.storage_policy.active = false`; `storage_inventory.initialized = false` for both workspaces; 0 ledger rows vs 236 real objects; 236/236 asset keys use the legacy `ws/<ws>/proj/<proj>/<uuid>` format, 0 use the ledger's `<logical>--<object>` format |
| Cloudflare R2 backend | INACTIVE | no R2 env vars; ledger `backend` check allows `r2` but no rows |
| Local FS storage adapter and `/api/storage/dev/[...key]` | deployed to production build; behaviour UNVERIFIED (fetch tool could not read the response) | build log lists the route |
| ElevenLabs generation/transcription with shared DB admission | ACTIVE | 34 `narration_requests` rows (28 generate succeeded, 3 generate failed, 3 transcribe succeeded) across 2026-09-19..21 |
| Browser rendering/export (mediabunny 1.50.4 with a patched Opus timing fix applied at `postinstall`) | ACTIVE | build log: `scripts/patch-mediabunny-opus-delay.mjs` |
| **Server render / durable worker** (`demo_private.render_queue`, claim/heartbeat/finish RPCs, `/api/render/enqueue`, `/api/render/download`) | **INACTIVE** (schema + routes deployed, no worker) | 0 `render_jobs`, 0 `render_queue`, 0 `workspace_usage` rows ever; no worker env vars; no Vercel cron visible; `pg_cron` not installed |
| Polar billing (`/api/billing/checkout`, `/api/billing/webhook`, `workspace_subscriptions`) | **INACTIVE** (routes deployed, no config) | 0 subscription rows; no Polar env vars; GET on both routes → `401 {"error":"unauthorized"}` |
| Sentry | INACTIVE | no DSN env var; Vercel runtime errors 7 d: none |
| Trigger.dev / any external job runner | INACTIVE | no env vars, no rows |
| Supabase Edge Functions, pg_cron, pgmq | not used | `list_edge_functions` = []; extensions not installed |
| macOS recorder (ScreenCaptureKit) + local authenticated handoff on `http://127.0.0.1:47655` | ACTIVE in the sense that production CSP allows `connect-src http://127.0.0.1:47655` | production CSP header |
| Log drains, PITR, SSO/SAML, MFA | not configured | `auth.sso_providers`=0, `auth.saml_providers`=0, `auth.mfa_factors`=0; no drains observed |

**Contradictions with the documentation you asked me to check (docs not readable here, inferred from names):** `docs/plans/2026-09-17-storage-lifecycle.md` describes a lifecycle that is deployed as schema but **switched off**; `docs/runbooks/b3-render.md` and `b4-billing.md` describe subsystems whose routes are deployed but which have **no runtime configuration**. Treat them as design records, not descriptions of production.

---

## 3. Prioritised findings (main / production)

Severity: **Critical / High / Medium / Low / Info**. Confidence: **Confirmed** (observed directly) / **Plausible** (mechanism visible, needs code confirmation) / **Optional**.

### F1 — Beta users can INSERT arbitrary `render_jobs` rows via PostgREST, bypassing export admission — **High / Confirmed**

- **Where:** Postgres grants and policy on `public.render_jobs` (migration `demo_pro_0003_render_jobs_rls` created `render_jobs_insert_member`; `demo_pro_0013_render_jobs_remove_update_rls` removed UPDATE but left INSERT).
- **Evidence:** `information_schema.role_table_grants` → `authenticated` has `DELETE, INSERT, SELECT` on `public.render_jobs`. `pg_policies` → `render_jobs_insert_member` (PERMISSIVE, INSERT, `WITH CHECK EXISTS(workspace_members m WHERE m.workspace_id = render_jobs.workspace_id AND m.user_id = auth.uid())`). The RESTRICTIVE `beta_admission` policy only requires the caller to be a beta user. There is no column restriction, no trigger, and no CHECK constraint on `status`, `output_storage_key`, `format`, or `preset`.
- **Reproduction (in a disposable Supabase project, never production):** as a beta user's JWT, `POST /rest/v1/render_jobs` with `{"workspace_id": "<own ws>", "project_id": "<own project>", "status": "done", "progress": 1, "format": "mp4", "preset": "x", "output_storage_key": "ws/<OTHER-TENANT-WS>/proj/<...>/renders/<...>.mp4"}` → 201.
- **Impact:** (a) export-minute quota accounting in `workspace_usage` is bypassed entirely, so the durable-admission plan's cost controls do not hold; (b) if `/api/render/download` resolves `render_jobs.output_storage_key` after checking membership on the job's own `workspace_id` and does **not** validate the key prefix against that workspace, this is a cross-tenant media read (IDOR via forged pointer) — **needs code confirmation**; (c) deleting the forged row fires `storage_capture_delete`, which inserts the foreign key into `storage_legacy_review` under the attacker's workspace, poisoning the human review list.
- **Minimal fix (migration):**
  ```sql
  REVOKE INSERT ON public.render_jobs FROM authenticated;
  DROP POLICY IF EXISTS render_jobs_insert_member ON public.render_jobs;
  ```
  All legitimate inserts already go through `enqueue_durable_render` (service role). Independently, make `/api/render/download` verify `output_storage_key LIKE 'ws/'||job.workspace_id||'/proj/'||job.project_id||'/renders/%'`.
- **Regression test:** pgTAP/RLS test: `SET ROLE authenticated; SET request.jwt.claims = '<beta user>'; INSERT INTO public.render_jobs (...)` must raise `42501`. Add a route test that a job whose key points outside its workspace prefix returns 404.

### F2 — The storage lifecycle ledger (authoritative sizes, reservations, orphan cleanup, storage quota) is deployed but **disabled** in production — **High / Confirmed**

- **Where:** `demo_private.storage_policy` singleton `active=false`; `demo_private.storage_inventory.initialized=false` for both workspaces; `public.reserve_storage_object` returns `not_activated` while the policy is off.
- **Evidence:** 0 rows in `demo_private.storage_objects`; 236 objects (413,062,018 bytes) in `storage.objects`; 236/236 asset keys in legacy format. Today there are **0 orphans** and **0 size mismatches** (`assets.size_bytes` equals object metadata for all 236), which is good hygiene by the current code path but is not enforced by any mechanism.
- **Impact:** no workspace storage quota can be enforced (`p_max_bytes` path never runs); orphan/abandoned-upload cleanup and reconciliation RPCs have nothing to process; `assets.size_bytes` is whatever the server wrote, not a verified observation; the recording-replacement race protection (`expected_storage_key` compare-and-swap in `publish_storage_object`) is not in force. Documentation describing this as shipped is misleading to future engineers.
- **Fix:** either (a) run the documented inventory review and set `active=true` with a controlled cut-over test in a disposable project first, or (b) if activation is intentionally deferred, say so in the runbook and add a temporary server-side quota check on `sum(assets.size_bytes)+recording_size_bytes` per workspace before launch.
- **Verification:** after activation, `SELECT count(*) FROM storage.objects o WHERE NOT EXISTS (SELECT 1 FROM demo_private.storage_objects s WHERE s.storage_key=o.name)` must trend to 0 for new writes; a synthetic upload whose declared size differs from the actual byte count must end in `cleanup_pending` (the `observe_storage_object` `size_mismatch` branch).

### F3 — Server render pipeline has no worker; enqueue path would strand jobs — **High for launch / Plausible**

- **Where:** `public.enqueue_durable_render`, `claim_durable_render`, `heartbeat_durable_render`, `finish_durable_render`, `demo_private.fail_render`; route `/api/render/enqueue`.
- **Evidence:** the queue and job tables have never held a row; no worker credentials or scheduler exist in Vercel; `pg_cron` not installed. `fail_render` (which refunds `export_seconds`) is only ever invoked from `claim_durable_render` or `finish_durable_render`, i.e. from a worker. There is no age-based expiry for `queued` rows.
- **Impact:** if `/api/render/enqueue` is reachable in production without a worker, a job stays `queued` forever with its reserved seconds charged against the monthly `workspace_usage` and never refunded. Whether the route fails closed when no worker is configured **needs code confirmation**.
- **Fix:** gate the route on an explicit `SERVER_RENDER_ENABLED`/worker-health flag that fails closed; add `queued_since` expiry in `claim_durable_render` or a reaper RPC (`fail_render` for rows queued > N minutes with no claim). When a worker is added, the design is sound: 90 s lease renewed by heartbeat, 30-minute per-attempt cap, ≤3 attempts, superseded attempt's partial upload is retired in the same transaction as the new lease, `finish` requires owner+attempt fencing and a sealed ledger object whose key and byte count match. A worker dying mid-render therefore results in lease expiry → next claim retires its file and retries; after 3 attempts the job fails and minutes are refunded. Note the worker's storage publish path needs the ledger (F2) active.
- **Test:** disposable DB: `enqueue` then advance clock (or set `created_at` back) → reaper marks `failed`, `workspace_usage.export_seconds` decremented; concurrent `claim_durable_render` from two owners returns one job each, never the same job (verify `FOR UPDATE SKIP LOCKED`).

### F4 — Access control is fail-closed for the beta, but the mechanism is a hard-coded allowlist and single-user workspaces — **High for launch / Confirmed**

- **Where:** `demo_private.beta_user_allowed()` (SECURITY DEFINER, `search_path=''`) hard-codes `steve@rangerandfox.tv` and `jared@rangerandfox.tv`; `demo_private.check_beta_signup()` BEFORE INSERT trigger on `auth.users` rejects any other email or non-Google provider; RESTRICTIVE `beta_admission` policies on every `public` table for `authenticated`.
- **What is right:** the allow function checks the JWT `sub`, `email`, `role`, `is_anonymous`, `amr` contains `oauth`, provider = google, `email_confirmed_at`, `banned_until`, `deleted_at`, and a verified Google identity with matching email. Even a leaked anon key plus a forged-provider user cannot read tenant data. Production `/` shows "Coming soon", `/login` shows Google-only sign-in, protected pages redirect to `/login`, API routes return 401 unauthenticated. Verified.
- **What blocks launch:** (1) removing the allowlist is a schema migration touching every table's RESTRICTIVE policy; plan it as one reviewed migration with an RLS test suite run in a disposable project. (2) `workspace_members` has SELECT-only grants and no invitation/role-change RPC; `handle_new_user_workspace` creates one personal workspace per user. Multi-seat workspaces do not exist. (3) `workspaces_update_owner` lets an owner update any column including `owner_id`; harmless today (no privileged columns), but add a column-level grant (`GRANT UPDATE (name)`) before adding plan/tier columns.
- **Note on advisor warning:** `public.is_workspace_member` is SECURITY DEFINER and executable by `authenticated`. It only returns whether the *caller* is a member of the given workspace (it uses `auth.uid()`), so it does not leak membership of other users. Keep it; the grant is required for the policy that uses it.

### F5 — Narration admission is correct but sized for two people; spend control is the provider key quota, not the app — **High for launch / Confirmed**

- **Where:** `public.narration_reserve/charge/dispatch/finish`, `demo_private.lock_narration_admission`, tables `narration_gate`, `narration_requests`, `narration_usage`.
- **Evidence (function bodies):** every call takes `FOR UPDATE` on the single `narration_gate` row (global serialization across all tenants, `lock_timeout=3s`); **global** cap of 2 active requests (`count(*) ... >= 2 → busy`); 1 active request per actor; 20 attempts / 30,000 characters / 100 MB per actor per rolling hour; 5,000 chars / 25 MB per request; `narration_usage` refuses new actors once it holds 1,000 rows; replay tombstones kept 7 days; `unknown` outcomes never refund. Multi-instance bypass is **not** possible: admission is in Postgres, so several Vercel instances cannot exceed the caps. Good.
- **Impact at scale:** a 500-seat customer will hit "busy" constantly (2 concurrent for the whole product); 3-second lock timeouts on one hot row will surface as errors under bursts; the 1,000-row cap is a hard user ceiling. Provider spend is bounded only by the ElevenLabs key's 10,000-credit period quota (per the env var comment), which is the right belt-and-braces, but there is no per-workspace monthly allowance, no metering table for billing, and no reconciliation against provider-reported usage.
- **Fix:** replace the global gate row with per-workspace gate rows (or advisory locks keyed by workspace) and a configurable global concurrency (e.g. 20–50 depending on plan concurrency); move caps to a `plan_limits` table; add `narration_usage_monthly(workspace_id, period, characters, source_bytes, provider_cost_estimate)` written in `narration_charge`; keep `narration_requests` as the idempotency ledger; add a daily job comparing charged characters with the ElevenLabs usage endpoint. Offer: included allowance per seat, metered overage at a margin over `$0.10/1k chars` (Multilingual v2) or `$0.05/1k` (Flash), and optional BYOK stored server-side (encrypted with Supabase Vault) for enterprises.
- **Test:** disposable DB: 3 concurrent `narration_reserve` for different actors → exactly 2 `reserved`, 1 `busy`; 1,001st actor → `limit`.

### F6 — No error monitoring, no log retention, no alerts, no WAF rules; scanners already probing — **Medium (High before launch) / Confirmed**

- **Evidence:** no Sentry DSN or log-drain configuration; Vercel Pro runtime logs retained 1 day (the 7-day query returned nothing); no firewall configuration; Vercel runtime logs (last day) show `/.env`, `/.env.backup`, `/xmlrpc.php`, `/wp-content/...`, `/api/session/reset_password` probes from the public internet; production status mix over the day: 200×100, 307×41, 401×12, 404×2. Supabase logs 24 h: 0 Postgres errors, 0 auth failures (traffic is tiny).
- **Impact:** an incident today would be diagnosed from at most 24 hours of Vercel logs and Supabase's log explorer; provider outages (ElevenLabs) and quota exhaustion would be invisible; no budget alarm exists on Vercel, Supabase, or ElevenLabs from what can be seen.
- **Fix (cheap):** enable Sentry (server + client, PII scrubbing on), add a Vercel log drain, set Vercel Spend Management and Supabase Spend Cap/alerts, enable Vercel Firewall rate-limit rules for `/api/narration/*`, `/api/storage/*`, `/auth/*`, set an ElevenLabs usage alert. Consider Vercel Bot Management/Attack Challenge Mode when public.

### F7 — Database capacity and recovery posture are beta-sized — **Medium / Confirmed**

- **Evidence:** `max_connections=60`, `shared_buffers` 256 MB, `work_mem` 3.5 MB → consistent with Supabase **Micro** compute (2 shared vCPU, 1 GB RAM, 200 pooler clients per official docs table fetched 2026-09-23). Auth server capped at 10 DB connections (advisor). `authenticated` `statement_timeout=8s`, `anon` 3 s, **`service_role` has none** (falls back to the 120 s global). Daily backups (7 days on Pro) do **not** include Storage objects (official docs). PITR not enabled. DB size 13.7 MB.
- **Impact:** fine for the beta. For a 500-seat customer, PostgREST connections from browsers plus service-role RPCs from Vercel functions must fit in 200 pooler clients / 60 direct; a runaway service-role query has no timeout; a deleted or corrupted bucket has no restore path beyond the 236 objects still existing.
- **Fix:** set `ALTER ROLE service_role SET statement_timeout = '30s'` (RPCs already use `lock_timeout=3s`); move to Small or Medium before launch; enable PITR (7-day, ≈$100/mo) once revenue exists; add nightly bucket replication (Supabase S3-compatible endpoint → R2 or S3) and **perform and time one full restore drill** into a disposable project, recording RPO/RTO. Today there is a backup policy but no tested restore.

### F8 — Billing routes are deployed with no billing configuration — **Medium / Plausible**

- **Evidence:** `/api/billing/checkout` and `/api/billing/webhook` are in the production build; no Polar env vars; both return 401 to unauthenticated GETs. Whether `POST /api/billing/webhook` fails closed when the webhook secret is absent (rather than accepting unsigned events) **needs code confirmation**.
- **Fix:** if Polar is not active, return 404/503 from both routes unless `POLAR_*` config is present and validated at boot (`config.server.ts` fail-closed). When activated: verify signature before parsing, store `polar_event_id` with a UNIQUE constraint for replay protection, order by `polar_event_at` (column exists), and reconcile subscriptions daily.

### F9 — CSP allows inline scripts and a fixed localhost origin — **Low / Confirmed**

- **Evidence:** `script-src 'self' 'unsafe-inline'`, `connect-src ... http://127.0.0.1:47655 https://vxohvyuelphxytkzvzgk.supabase.co`; `x-powered-by: Next.js` present.
- **Impact:** XSS mitigation is weakened by `'unsafe-inline'`; the fixed handoff port advertises the recorder's local endpoint; both are low risk given the rest of the headers.
- **Fix:** nonce-based CSP via the proxy/middleware; add the localhost origin only on `/record/desktop`; `poweredByHeader: false` in `next.config.ts`.

### F10 — Dev-only pages and routes ship in the production bundle — **Low / Partly verified**

- **Evidence:** `/dev/parity`, `/dev/media-entrance`, `/dev/screen-inspector`, `/dev/text-*`, `/api/storage/dev/[...key]` are in both production and preview builds. `/dev/parity` returns **404** in production (fail-closed verified). `/api/storage/dev/...` could not be read by the fetch tool (twice) — **unverified**; confirm it returns 404 when `STORAGE_BACKEND != fs`.
- **Fix:** exclude `/dev/**` and the fs storage route from production builds (environment-conditional route files or `next.config.ts` rewrites to 404).

### F11 — Schema drift indicators — **Low / Confirmed**

- `projects_document_admission` CHECK is `NOT VALID` (0 inadmissible rows today; run `ALTER TABLE ... VALIDATE CONSTRAINT` in a migration).
- Trigger `storage_guard_recording_pointer` fires only `WHEN CURRENT_USER='authenticated'`, but `authenticated` has **no UPDATE grant** on `projects` (only SELECT, DELETE), so the guard is dead code and the `projects_update_member` policy is unreachable. Not a vulnerability; it shows the migration sequence and the code's assumptions have diverged. Document which writes are client-side (none today) and drop the unreachable policy or the trigger.
- Leaked-password protection is disabled (irrelevant while only Google OAuth is enabled; enable it anyway so a future email provider inherits it).

### F12 — Upload path vs Vercel request body limits — **Medium / Plausible**

- **Evidence:** the ledger models a `server` write mode (bytes proxied through a route, `/api/storage/uploads/[id]`) and a `signed` mode (`/api/storage/presign`, 6 hits in the last day). Bucket allows 500 MB objects; the largest object today is 23 MB (a WAV). Vercel Functions cap request bodies at 4.5 MB (official limit; confirm at vercel.com/docs/functions/limitations).
- **Impact:** if any client path sends recordings or WAVs through the server route, uploads above 4.5 MB fail on Vercel regardless of app limits; the ledger's strongest guarantees (`sealed`, single-use write claim) exist only for `server` mode, so large files necessarily get the weaker `signed` guarantees (charged at `greatest(reserved, actual)`).
- **Fix/confirm:** ensure all media > 4 MB uses signed or TUS resumable uploads to Supabase's direct storage host and that `observe_storage_object` is called from a finalize route using the object's HEAD metadata. Keep `server` mode for small files only.

### Positive verifications (no action)

- All 8 `demo_private` tables have RLS enabled and **no** grants to `anon`/`authenticated` (the advisor's "RLS enabled, no policy" INFO is the intended deny-all).
- Every function has `SET search_path = ''`; SECURITY DEFINER is used only for the allow-check, workspace bootstrap, and storage tombstone triggers.
- `anon` has no table grants in `public`.
- Document admission CHECK validates structure and bounds (4 MB max doc, integer frame bounds, clip ordering) at the DB, so a malicious save cannot store arbitrary JSON shapes.
- Storage sign calls are all service-role, and the bucket is private.

---

## 4. Draft PR #30 (`5ea7206`, recorder handoff + microphone waveform) — separate findings

- **Server surface:** the preview build's route list is **identical** to main's (compared build logs line by line): no new API routes, no new middleware. Whatever the draft changes is client-side and in the Swift app. The preview is SSO-protected.
- **Not reviewed:** the diff itself (no repo access). The following are therefore requirements, not findings:
  1. **Handoff authentication:** the browser calls `http://127.0.0.1:47655` (in production CSP). Confirm the native app binds to loopback only, requires a per-session secret exchanged out of band (not guessable, not in the URL), validates `Origin: https://demopro.studio`, and rejects cross-origin `POST`s from other tabs (a malicious page can also reach 127.0.0.1). Confirm a fresh port/secret per launch so a stale CSP origin does not become a fixed target.
  2. **Automatic import:** treat the recording package as untrusted input: enforce size caps before reading, validate container/codec with the existing media limits, never decompress unbounded archives in memory.
  3. **Microphone recording:** `Permissions-Policy: microphone=(self)` already allows it; make sure the waveform path does not keep raw PCM in unbounded arrays for long recordings.
  4. **Signing:** the candidate is ad-hoc signed. Do not distribute outside the two beta machines until Developer ID signing + notarization exist; Gatekeeper will block ad-hoc builds on other Macs and the runbook should say so.
  5. **The 5–10 second stop bug has no root cause.** A 32-second synthetic capture is not evidence. Before merge, run three physical captures ≥ 5 minutes with mic on, on the same hardware that reproduced the stop, with `os_log` capture enabled, and attach the logs to the PR.
  6. Keep `main` and this branch behaviourally separated: nothing in the DB or Vercel config changes for the draft, so rollback is a plain revert.

---

## 5. Infrastructure checks I could not perform

- Any source-code review of `demo-pro` (see §0). Specifically unverified: `src/proxy.ts` gating, `config.server.ts` fail-closed behaviour, `/api/render/download` key validation, `/api/billing/webhook` signature handling, storage adapter selection, upload size limits, SSRF/command injection in media handling, client-bundle secret leakage (the public bundle only needs the anon key and URL).
- `npm ci && npm run gate && npm run test:rls` (no checkout; also the sandbox blocks outbound web egress).
- Supabase organisation plan tier, compute add-on name, Spend Cap, backup list, PITR status, Auth provider settings (email/password enabled?), custom SMTP, JWT expiry, network restrictions, SSL enforcement (dashboard-only settings; the MCP exposed none of them).
- Vercel Spend Management settings, function `maxDuration`/memory, cron definitions (`vercel.json` not readable), Web Analytics, Deployment Protection bypass tokens, team member list and 2FA enforcement.
- ElevenLabs dashboard: plan, actual credit consumption, key scopes (only the env var comment attests to "read-only voices, 10,000 credits").
- Google Cloud OAuth client ownership and redirect URIs.
- Domain registrar/DNS ownership for `demopro.studio` (Vercel reports the domain verified, not who owns the registration).
- Apple Developer account, signing identities.
- Two production responses the fetch tool could not read: `/api/storage/dev/...` and `/record/desktop`.

---

## 6. Capacity and cost model

**Measured beta baseline (2026-09-15 → 09-23):** 2 users, 26 projects, 236 assets, 413 MB stored (72% audio, 15% PNG); average asset 1.75 MB, max 23 MB; average project document 9.9 KB (max 30 KB); 28 successful TTS generations = 35,277 characters (~1,260 chars each) plus 3 transcriptions (519 KB); ~160 Supabase API requests and ~155 Vercel requests per day.

**Official inputs (retrieved 2026-09-23):**
- Supabase compute table (docs `platform/compute-and-disk`): Micro ~$10/mo (1 GB, 60 direct / 200 pooler clients), Small ~$15 (2 GB, 90/400), Medium ~$60 (4 GB, 120/600), Large ~$110 (8 GB, 160/800), XL ~$210 (16 GB, 240/1,000). Pro plan $25/mo includes $10 compute credit. Egress: 250 GB included, then $0.09/GB uncached, $0.03/GB cached (docs `manage-your-usage/egress`). Daily backups 7 days on Pro; PITR 7-day ≈$100/mo (docs `platform/backups`). File storage overage is $0.021/GB-month after 100 GB on Pro (supabase.com/pricing; confirm on the page).
- Vercel Pro: $20/seat/mo with $20 usage credit; 1 TB Fast Data Transfer and 10 M edge requests included; Active CPU / Provisioned Memory / invocations metered beyond that (vercel.com/docs/plans/pro-plan and vercel.com/docs/pricing; confirm unit rates). Function request body limit 4.5 MB; Pro default max duration 300 s with Fluid compute (confirm at vercel.com/docs/functions/limitations). Runtime log retention 1 day on Pro.
- Cloudflare R2 (developers.cloudflare.com/r2/pricing): $0.015/GB-month Standard, Class A $4.50/M, Class B $0.36/M, **egress $0**, 10 GB free.
- ElevenLabs API (elevenlabs.io/pricing/api; figures via 2026 third-party summaries, confirm on the page): ≈$0.10 per 1,000 characters (Multilingual v2 / v3), ≈$0.05 (Flash/Turbo); Scale $299/mo ≈1.8 M credits; Business $990/mo ≈11 M credits; concurrency rises with plan.

**Workload assumptions (state them, then adjust):** editing is browser-local; the server sees project saves (10–30 KB), PostgREST reads, signed-URL issuance, uploads, narration calls. Weekly-active ratio 20%; an active editor loads ~30 MB of assets per session and saves every ~30 s; 10 narration generations/user/month at 1,300 chars; 5 projects/user at ~16 MB plus screen recordings of 50–200 MB for a third of projects.

| Scenario | Concurrency (edit / upload / AI / export) | Storage yr-1 | Egress/mo | Infra $/mo | AI $/mo (list) | Binding constraints today |
|---|---|---|---|---|---|---|
| **A. Beta (2 users)** | 2 / 1 / 1 / 1 | <1 GB | <5 GB | Vercel $20–40 + Supabase $25 (+$0 compute) ≈ **$45–65** | ElevenLabs plan $22–99 | none |
| **B. One 500-seat enterprise** (100 WAU) | 30 / 5 / 3 / 2 (browser) | 150–400 GB | 60–150 GB (in quota) | Vercel $40–80, Supabase $25 + Small/Medium $15–60 + storage $1–6 ≈ **$85–170** | 6.5 M chars → **$325–650** (needs Business tier for credits) | narration global cap 2 (F5) → immediate "busy"; single-user workspaces (F4); no SSO; storage quota off (F2) |
| **C. 3 enterprises + 3,000 individuals** (~4,500 seats, ~900 WAU) | 250 / 30 / 15 / 10 | 1–3 TB | 0.5–2 TB → $25–160 over quota | Vercel $100–300, Supabase $25 + Medium/Large $60–110 + storage $20–60 + egress $25–160 + PITR $100 ≈ **$330–750** | 58 M chars → **$2,900–5,800** | Micro/Small pooler clients; global narration lock contention; 1,000-actor cap; no worker for server exports; 1-day log retention |

**Take-aways:** (1) Infrastructure is cheap at every stage; **narration is the dominant cost** and must be priced into plans (included allowance + metered overage + BYOK for enterprises). (2) Egress, not storage, is the first Supabase overage; moving media to **R2 behind the existing storage adapter** removes egress cost and the 4.5 MB proxy problem (uploads go direct via presigned PUT/multipart), at the price of a second account to own and a one-time copy of ≤1 TB; the ledger already models `backend='r2'`. Recommended for stage C, optional for B. (3) Server rendering, when needed, belongs on a small dedicated worker (Railway/Fly/Hetzner, $20–200/mo) claiming from `render_queue`, not on Vercel functions (duration and memory caps); the DB design is ready for it. (4) Do not rewrite: the Next.js + Supabase + Postgres-admission architecture scales to stage C with compute upgrades and the fixes in §7.

---

## 7. Staged remediation plan

**Immediate (this week, beta stays open):**
1. Migration: revoke `INSERT` on `render_jobs` from `authenticated`, drop `render_jobs_insert_member` (F1). Add key-prefix validation in `/api/render/download` (needs code).
2. `ALTER ROLE service_role SET statement_timeout='30s'` (F7).
3. Enable Sentry + Vercel log drain + Vercel Spend Management + Supabase spend alerts + ElevenLabs usage alert (F6).
4. Confirm fail-closed behaviour of `/api/render/enqueue`, `/api/billing/*`, `/api/storage/dev/*` in code; add 404/503 when unconfigured (F3, F8, F10).
5. Run one restore drill of the DB into a disposable project and one bucket copy; record RPO/RTO (F7).

**Pre-public-launch:**
6. Replace the hard-coded allowlist with a `beta_allowlist`/`plans` table driven migration; keep RESTRICTIVE policies; write RLS tests that run against a real disposable Postgres (not PGlite) for cross-tenant, role-change, and anonymous cases (F4).
7. Activate the storage lifecycle ledger after an inventory review in staging; then enforce per-workspace storage quota (F2). Route all media > 4 MB through signed/TUS uploads (F12).
8. Re-size narration admission (per-workspace gates, plan limits table, monthly usage ledger, provider reconciliation) and decide the offering (F5).
9. Workspace membership: invitations, roles, removal, with RPCs and RLS tests (F4).
10. Vercel Firewall rate limits on auth/AI/storage routes; nonce CSP; strip dev routes from prod builds (F6, F9, F10).
11. Supabase compute → Small/Medium; PITR on; bucket replication nightly (F7).
12. Billing: activate Polar only with signature verification, event-id uniqueness, ordering, daily reconciliation (F8).
13. Data-deletion workflow (user/workspace delete cascades already exist at the FK level; add storage object purge via the ledger cleanup RPCs) and a documented retention policy.

**Enterprise (later):**
14. SSO (Supabase Auth SAML is GA), SCIM provisioning (custom, Supabase has no SCIM API surface for end-user apps), audit log table with append-only trigger for tenant-visible events, per-workspace retention settings, DPA/subprocessor list, optional regional projects (Supabase per-region project + Vercel region pinning), customer-managed narration keys, admin console. No compliance certification is implied by any of this.

---

## 8. Service-ownership migration checklist (Ranger & Fox → Demo Pro)

Confirmed resources today: GitHub repo under personal account `steve-rangerandfox`; Vercel team `steve-rangerandfoxs-projects` (personal-scoped Pro team that also hosts Kit and other R&F projects); Supabase org `jgqbmyajtgdevofgnqvg` (also hosts Kit, talenthub, Social Studio, Founder OS); ElevenLabs key labelled "Demo Pro Production"; domain `demopro.studio` verified on Vercel (registrar unknown); Google OAuth client (owner unknown); Apple signing (ad-hoc only). Proposed/unconfigured: R2, Polar, Sentry, log drains, status page.

Staged transfer with continuity:
1. **Create the Demo Pro entities:** GitHub organisation, Vercel team (Pro), Supabase organisation (Pro), Cloudflare account (DNS + optional R2), Google Cloud project, ElevenLabs workspace, Apple Developer Program (Developer ID), Sentry org. Use a shared password manager and a `security@demopro` group as recovery email; enforce 2FA everywhere.
2. **Repository:** transfer `steve-rangerandfox/demo-pro` to the new org (GitHub keeps redirects). Re-install the Vercel Git integration on the new org; re-link the project. Rotate any PATs in CI.
3. **Supabase:** use **Project Transfer** (docs `platform/project-transfer`) to move `vxohvyuelphxytkzvzgk` to the new org — the project ref, URL, keys, data, and Auth users stay the same, so no user impact. Then rotate the service-role key and the DB password (update Vercel env), regenerate anon/publishable key if desired.
4. **Vercel:** use **Project Transfer** (REST `POST /projects/{id}/transfer-request`, accept from the new team) — deployments, domains and env vars move; re-add sensitive env values if the transfer drops them; verify `demopro.studio` still resolves to the project and re-issue certificates if prompted. Keep the old team until the first successful production deploy from the new team.
5. **Google OAuth:** create the client in the Demo Pro GCP project, register the Supabase callback URL, add the new client ID/secret in Supabase Auth, keep the old client active for a week, then remove it. Users re-consent silently; `auth.identities` keys on provider `sub`, so accounts persist.
6. **ElevenLabs:** new workspace, new scoped key (TTS+STT+voices-read, credit cap), update Vercel env, revoke old key.
7. **Domain/DNS:** transfer registration to the new registrar account (60-day lock after transfer), move DNS to the new Cloudflare zone with identical records first, then switch nameservers; Vercel domain verification stays valid if records match.
8. **Backups before each step:** take a Supabase logical dump and a bucket copy; verify restore into a disposable project.
9. **Verification of ownership:** each service shows the new org as owner with ≥2 owners; old accounts removed from teams; all rotated credentials confirmed by a production smoke test (login, project load, signed URL, narration).
10. **Rollback:** every transfer above is reversible within the provider's window (GitHub/Vercel/Supabase transfers can be re-initiated); keep old credentials sealed in the password manager until the post-transfer week is clean.

---

## 9. Test commands and results

Run in this session (all read-only):
- Supabase SQL over the MCP connector: policies, function definitions, grants, triggers, constraints, indexes, counts, orphan analysis, role settings (queries reproduced in §10).
- Supabase log queries (24 h): request paths/status/roles, auth/storage events, pgbouncer.
- Supabase advisors: security (3 lint types; see F4 note and F11) and performance (9 unused indexes on never-populated tables, Auth connection strategy INFO).
- Vercel: project, env var names, domains, deployments (production and preview), build logs for `d639817` and `5ea7206`, runtime logs grouped by path/status, runtime errors (none in 7 d), firewall config (none).
- Production HTTP checks via Vercel's fetch tool: `/`→200 Coming Soon; `/login`→200 Google-only; `/projects`, `/learn`→redirect to `/login`; `/dev/parity`→404; `/api/narration/voices`, `/api/projects`, `/api/render/enqueue`, `/api/billing/checkout`, `/api/billing/webhook`, `/api/storage/presign`→401 `{"error":"unauthorized"}`; `/robots.txt`→`Disallow: /`.

Not run: `npm ci`, `npm run gate`, `npm run test:rls` (no source access). **Coverage gaps even if those pass:** PGlite single-session tests cannot exercise `FOR UPDATE SKIP LOCKED`, `lock_timeout`, or two-session races in `claim_durable_render`, `narration_reserve`, `reserve_storage_object`; RLS tests must run as `authenticated` with realistic JWT claims (including `amr`) against Postgres 17.

---

## 10. Appendix — key evidence queries (safe to re-run read-only)

```sql
-- grants that let clients write
select grantee, table_name, string_agg(privilege_type, ',') from information_schema.role_table_grants
 where table_schema='public' and grantee in ('anon','authenticated') group by 1,2 order by 2,1;
-- policies
select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname='public';
-- lifecycle state
select * from demo_private.storage_policy; select * from demo_private.storage_inventory;
select count(*) ledger_rows from demo_private.storage_objects; select count(*) objects from storage.objects;
-- orphans
select count(*) from storage.objects o where not exists (
  select 1 from public.assets a where a.storage_key=o.name
  union all select 1 from public.projects p where p.recording_storage_key=o.name
  union all select 1 from public.render_jobs r where r.output_storage_key=o.name);
-- role timeouts and compute signals
select rolname, rolconfig from pg_roles where rolname in ('anon','authenticated','service_role');
select name, setting from pg_settings where name in ('max_connections','shared_buffers','work_mem');
```

Proposed regression tests (disposable Postgres, pgTAP or the repo's RLS harness):
1. `authenticated` INSERT into `public.render_jobs` → `42501` (after F1 fix).
2. Two sessions calling `claim_durable_render` concurrently on a two-row queue receive distinct jobs.
3. `finish_durable_render` with a stale `attempt` or expired lease returns `false` and leaves the job `rendering`.
4. Three concurrent `narration_reserve` for three actors: two `reserved`, one `busy` (pre-fix); after re-sizing, assert the configured cap.
5. `reserve_storage_object` returns `not_activated` while policy inactive, `reserved` after activation, `quota` when `p_max_bytes` would be exceeded, and `observe_storage_object` with a mismatched byte count moves the row to `cleanup_pending`.
6. Non-allowlisted Google user: `auth.users` insert raises `42501`; existing allowlisted user with a JWT lacking `amr:oauth` sees zero rows from `public.projects`.

## 11. Code-confirmation checklist for the follow-up session (with repo access)

1. `src/proxy.ts`: every non-public path requires a session; `/dev/**` and `/api/storage/dev/**` are 404 in production.
2. `src/lib/config.server.ts`: production fails to boot (or routes fail closed) when `ELEVENLABS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or storage config is missing; Polar/R2/Sentry are optional and default to off.
3. `/api/render/download`: validates key prefix against the job's workspace/project; `/api/render/enqueue`: fails closed without a worker.
4. `/api/storage/presign` and `/api/storage/uploads/[id]`: size caps, content-type checks, which write mode is used for what size, and how `size_bytes` is determined (HEAD metadata vs client claim).
5. `/api/billing/webhook`: signature verification before body parse; behaviour when secret missing.
6. `/api/narration/*`: request/body limits vs Vercel 4.5 MB; cancellation propagates to the provider call; `unknown` outcome handling.
7. Client bundle: only `NEXT_PUBLIC_*` values present; no service-role key.
8. `desktop/recorder-macos`: loopback bind, origin check, per-launch secret, package validation, signing/notarization plan.
9. `.github/workflows`: gate runs on PRs; `test:rls` targets real Postgres; secrets not echoed.
