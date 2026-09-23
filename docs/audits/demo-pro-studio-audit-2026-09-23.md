# Demo Pro Studio — Independent Backend, Security, Reliability, Scale and Cost Audit

**Date:** 2026-09-23
**Auditor:** Claude (independent second review, read-only)
**Audited production commit:** `d6398174d34e273d65e4e096eb49b8474e65ab53` (branch `main`) — confirmed as the live production deployment `dpl_3Z4VPpUG5iThK58cDCeBrguoCqx4` serving `demopro.studio` (Vercel, region `iad1`, Next.js 16.3.4, Node 22.x, Pro plan). The response HTML of `https://demopro.studio/` carries `data-dpl-id="dpl_3Z4VPpUG5iThK58cDCeBrguoCqx4"`, so main HEAD and production are the same commit. A fresh clone of the repository at the same SHA was reviewed.
**Draft reviewed separately:** PR #30, branch `fix/recorder-handoff-audio-2026-09-22`, commit `5ea7206424efe414814bf3f99773a7f4b1adcdd0` (23 files, +901/−79), built as preview `dpl_7DfGy5ycGWz4eXLM7sKYbQBNADbu` (not production).
**Database state observed:** Supabase project `vxohvyuelphxytkzvzgk` (us-east-1, Postgres 17.6), read-only SQL on 2026-09-23.

Nothing was modified, deployed, migrated, rotated, or load-tested. No customer media or secrets left the session.

---

## 0. Scope of evidence

| Evidence class | Status |
|---|---|
| Source at `d6398174` (routes, proxy, auth, storage, narration, jobs, billing, render, capture, Swift recorder, migrations, RLS tests, CI) | **Reviewed** |
| PR #30 full diff (`main...5ea7206`) | **Reviewed** |
| Live Supabase schema, every RLS policy, function body, grant, trigger, constraint, role setting, 24 h logs | **Reviewed** |
| Vercel project, env var *names*, domains, protection, firewall, build logs for both commits, 24 h runtime logs | **Reviewed** |
| Black-box HTTP behaviour of production | **Reviewed** |
| Official pricing and limits documentation | **Reviewed** (dated below) |
| `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit` | See §9 |
| `npm run gate` (visual + e2e), `npm run test:rls` (Docker + Supabase CLI), Swift tests | **Not run** — no Docker, no macOS, no ffmpeg in the sandbox |
| Dashboard-only settings (Supabase plan tier, PITR, spend cap; Vercel spend management; ElevenLabs plan; Google OAuth client; DNS registrar; Apple signing) | **Not visible** (§5) |

Documentation, code comments and "accepted risk" notes were read as context only. Where they contradict the code or the database, the contradiction is reported.

---

## 1. Readiness verdict

| Stage | Verdict | Why |
|---|---|---|
| **Current two-user private beta** | **Acceptable with the "immediate" items in §7** | Gating is fail-closed at three layers (proxy, server client, RESTRICTIVE RLS) and confirmed in code. Remaining beta-relevant gaps: no error monitoring or spend alarms (F6), forgeable `render_jobs` rows (F1, now Medium), service-role role has no statement timeout (F7). |
| **Public launch (self-serve individuals)** | **Not ready** | Hard-coded allowlist in SQL and in `beta-policy.ts` (F4); storage lifecycle ledger disabled so no storage quota is enforced (F2); narration capped at 2 concurrent jobs globally with a 1,000-actor ceiling (F5); no observability, no tested restore (F6/F7); billing dormant (F8); no server render worker (F3); RLS suite is not a required check (F13). |
| **Enterprise (500-seat customers)** | **Not ready; several quarters** | Single-user workspaces with no invitation path; no SSO/SCIM/audit log/retention controls; smallest Supabase compute tier; single region; storage objects not in backups; no deletion workflow. |

**What is good and should be kept.** Every admission decision (project create, render enqueue/claim/finish, narration reserve/charge/finish, storage reservations) is a Postgres function with `search_path=''`, row locks, idempotent replays, and fencing tokens. Private tables live in `demo_private` with no client grants. The bucket is private with no client `storage.objects` policies. Route handlers derive storage keys from ids rather than trusting stored pointers (`scopedMediaStorageKey`, `renderOutputKey`). The Polar webhook verifier is a correct Standard Webhooks implementation with constant-time compare and a replay window. ffmpeg is invoked with argument arrays and protocol/format whitelists. The macOS handoff server binds loopback only, requires an exact Origin and a constant-time bearer compare, and rejects non-GET methods. Security headers are strong. This is a better foundation than most products at this stage.

---

## 2. Actual architecture and service map

Legend: **ACTIVE** = observed in production. **INACTIVE** = code/schema exists, no configuration or rows. **DEV-ONLY** = compiled in but returns 404/503 in production (verified in code). **UNVERIFIED** = not confirmable from this session.

| Component | Status | Evidence |
|---|---|---|
| Vercel project `demo-pro` (prj_N6n9WpHUPiw37tXd5NOfijNvuSXi), team `steve-rangerandfoxs-projects` (Pro) | ACTIVE | `get_project`, deployment object |
| Production domain `demopro.studio` (+3 `*.vercel.app` aliases), region `iad1`, Node 22.x | ACTIVE | deployment object |
| Preview protection: Vercel SSO on non-custom domains; no password on production | ACTIVE | `ssoProtection.deploymentType = all_except_custom_domains` |
| Vercel Firewall rules / rate limits | **NOT CONFIGURED** | `get_firewall_config` → not found |
| Production env vars (names only): `ELEVENLABS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ACTIVE | exactly 5; none for R2, Polar, Sentry, Trigger.dev, `DEMO_PRO_DURABLE_RENDER`, `DEMO_PRO_LOCAL_RENDER`, `STORAGE_LIFECYCLE_ENABLED`, `DATABASE_URL` |
| Request gating: `src/proxy.ts` → `refreshSessionAndGuard`; production 404 for `/dev*` and `/api/storage/dev/`; redirects `/marketing`, `/welcome` → `/`; API 401 JSON; fail-closed when cloud is unconfigured | ACTIVE | code + black-box |
| Server auth: `getServerClient` returns null unless `verifiedBetaUser` (getUser + getClaims: `sub`, `role`, `email`, `amr` contains `oauth`, email in `BETA_EMAILS`) | ACTIVE | `src/lib/auth/server-client.ts`, `beta-policy.ts` |
| Supabase Auth, Google OAuth only; PKCE; `authRedirectOrigin` hard-codes `https://demopro.studio` in production; Origin-checked sign-out | ACTIVE | 2 users, 2 google identities; `src/app/auth/*` |
| Browser → PostgREST with user JWT: reads on `workspace_members`, `projects`, `assets`, `render_jobs`; **column-level UPDATE on `projects`** for autosave (`title, resolution, doc, duration_frames, recording_storage_key, recording_type, updated_at`); DELETE on `projects`, `render_jobs`; UPDATE on `workspaces` | ACTIVE | migration 0014; `postgrest-provider.ts saveProject/saveDocument`; 24 h logs |
| Server → Supabase with service role for `create_project_with_quota`, asset metadata insert, presign, finalize, narration RPCs | ACTIVE | route handlers |
| Drizzle schema / 21 SQL migrations | ACTIVE | `list_migrations`; `src/lib/db/migrations` |
| Storage bucket `demo-pro-private` (private, 500 MB object limit, no MIME allow-list) via `SupabaseStorageBackend` (signed upload URLs, 15-min signed GETs, 30 s timeouts) | ACTIVE | `src/lib/storage/backend.ts`; 236 objects, 413 MB |
| Storage lifecycle ledger (`demo_private.storage_objects`, reservations, cleanup, inventory, `/api/storage/uploads/[id]` server-write path ≤4 MiB) | **INACTIVE** | `storage_policy.active=false`; `STORAGE_LIFECYCLE_ENABLED` unset so `storageLifecycleEnabled()` is false; presign takes the legacy branch guarded by `requireLegacyStorageWrites()` |
| Cloudflare R2 adapter (SigV4) | INACTIVE | no env vars; selected only when `r2Config()` is complete |
| Local FS adapter and `/api/storage/dev/[...key]` | DEV-ONLY | `isFsStorageEnabled` requires dev/test; proxy 404s the path in production |
| ElevenLabs (`eleven_multilingual_v2` TTS, `scribe_v2` STT) with DB admission; 90 s provider deadline; UUID `Idempotency-Key` required; 4 MiB source cap, 5,000 chars, 16 MiB output | ACTIVE | 34 `narration_requests`; `src/lib/narration/*` |
| Browser export (mediabunny 1.50.4 + Opus patch at postinstall) | ACTIVE | build log |
| Server render: `enqueue_durable_render`/claim/heartbeat/finish RPCs, `runDurableRenderOnce` worker, skia-canvas + system ffmpeg | **INACTIVE** | `/api/render/enqueue` returns **503** in production unless `DEMO_PRO_DURABLE_RENDER=1` or `DEMO_PRO_LOCAL_RENDER=1` (neither set); 0 rows ever; no worker host; `pg_cron` absent |
| Polar billing (`/api/billing/checkout`, `/api/billing/webhook`) | **INACTIVE** | both return 404 when Polar config is absent or during private beta; verifier present |
| Sentry (`withSentryConfig`, instrumentation, PII scrub) | INACTIVE | gated on DSN; none set |
| Trigger.dev `TriggerJobQueue` | INACTIVE (stub) | `triggerConfigured()` false |
| macOS recorder (ScreenCaptureKit) + loopback handoff `http://127.0.0.1:47655` | ACTIVE (client side) | CSP `connect-src`; `recorder-bridge.ts`; `HandoffServer.swift` |
| Supabase Edge Functions, pg_cron, pgmq, log drains, PITR, SSO/SAML, MFA | not used / not configured | MCP listings; `auth.*` tables empty |

**Contradictions between documentation and reality.** `docs/plans/2026-09-17-storage-lifecycle.md` and the ledger code describe an active lifecycle; production has it switched off at both the env flag and the DB policy. `docs/runbooks/b3-render.md` / `b4-billing.md` describe subsystems whose routes are deployed but dormant. Header comments in `postgrest-provider.ts` say `recording_storage_key`/`recording_type` "remain client-written"; that is true and is the mechanism behind F11. `supabase/config.toml` pins `major_version = 15` while production runs Postgres 17.6 (F13).

---

## 3. Prioritised findings (main / production, commit `d6398174`)

Severity: **Critical / High / Medium / Low / Info**. Confidence: **Confirmed** (code + DB observed) / **Plausible**.

### F1 — Beta users can INSERT and DELETE arbitrary `render_jobs` rows via PostgREST — **Medium / Confirmed** (downgraded from High)

- **Where:** migration `0003_render_jobs_rls.sql` (policy `render_jobs_insert_member`), `0014_app_role_grants.sql` (`GRANT SELECT, INSERT, DELETE ON render_jobs TO authenticated`); live `pg_policies` and `role_table_grants` agree. `supabase/tests/rls_4_render_jobs_test.sql` asserts that a member **can** insert, so this is design intent for the legacy enqueue path.
- **Why the grant exists:** `src/app/api/render/enqueue/route.ts:325` inserts `render_jobs` through the **user's** session in the legacy path. That path is unreachable in production (`route.ts:308` returns 503 unless `DEMO_PRO_LOCAL_RENDER=1`), and the durable path inserts via service-role RPC. So in production the grant serves no legitimate caller.
- **What a forged row can and cannot do (code-verified):**
  - **Cannot** read another tenant's media. `/api/render/download` (`src/lib/jobs/render-download.ts`) derives the object key from `(workspace_id, project_id, job id)` via `renderOutputKey` and accepts only a UUID leaf under `ws/{ws}/proj/{proj}/renders/{job}/`; a forged `output_storage_key` is ignored. The earlier "IDOR via forged pointer" concern is **withdrawn**.
  - **Can** pollute the export queue UI: `export-queue-client.ts` lists `render_jobs` by workspace and validates only `workspace_id`, `status`, `id`, `created_at`.
  - **Can** poison the storage tombstone tables: deleting a row fires `storage_capture_delete`, which inserts `output_storage_key` into `storage_legacy_review` under the attacker's workspace.
  - **Can** bypass `workspace_usage` accounting only in the sense of creating unaccounted rows; no render is executed, so no cost is incurred today.
- **Minimal fix (migration):** `REVOKE INSERT ON public.render_jobs FROM authenticated; DROP POLICY render_jobs_insert_member;` and move the legacy dev insert to the service-role client (it already holds one, `usageServiceRoleClient`). Update `rls_4_render_jobs_test.sql` to assert `42501` on member INSERT. Consider revoking DELETE too and exposing a `cancel_render(job_id)` RPC that checks state.
- **Regression test:** pgTAP: member INSERT → `42501`; route test: enqueue in dev still succeeds via service role.

### F2 — Storage lifecycle ledger deployed but disabled; no storage quota is actually enforced — **High / Confirmed**

- **Where:** `demo_private.storage_policy.active=false`; `storage_inventory.initialized=false`; `STORAGE_LIFECYCLE_ENABLED` unset so `storageLifecycleEnabled()` is false; `/api/storage/presign` therefore runs the legacy branch (`route.ts:139-178`).
- **What the legacy branch does enforce (code):** declared `contentLength` ≤ 500 MB; for library assets, `assets.size_bytes` must equal `contentLength`; `workspaceStorageBytes` (sum of `assets.size_bytes` + `recording_size_bytes`) + new bytes ≤ plan limit (`checkStorageQuota`); `requireLegacyStorageWrites()` fails if the DB policy is later activated. Recording size is stamped server-side by `/api/recording/finalize` from HEAD metadata with a CAS on `recording_storage_key`.
- **What is not enforced:** the **actual** uploaded byte count for library assets is never observed (signed upload URL with `upsert:true`; Supabase enforces only the bucket's 500 MB limit); a client can declare 1 KB and upload 400 MB; orphan and abandoned-upload cleanup has nothing to process. Today 0 orphans and 0 size mismatches, by good behaviour, not by mechanism.
- **Fix:** activate the ledger after a staging inventory review, or add an interim finalize step for library assets mirroring `/api/recording/finalize` (HEAD the object, compare to `size_bytes`, delete on mismatch). Prefer `presignPutOnce` (no upsert) for new keys.
- **Verification:** synthetic upload with declared ≠ actual size must be rejected or cleaned; after activation, `storage.objects` without a ledger row must trend to 0 for new writes.

### F3 — Server render pipeline has no worker; route fails closed — **Medium for launch / Confirmed fail-closed**

- **Code:** `/api/render/enqueue` returns 503 in production without `DEMO_PRO_DURABLE_RENDER=1` (durable RPC) or `DEMO_PRO_LOCAL_RENDER=1` (in-process, explicitly "DEV/LOCAL ONLY"). Neither is set. The earlier concern about stranded jobs is **not exploitable today**.
- **Remaining design gap:** if the durable flag is turned on without a running worker, `enqueue_durable_render` reserves `export_seconds` and the row stays `queued` forever; `fail_render` is only invoked from `claim`/`finish`. Add a `queued_since` expiry (reaper) before enabling. The lease/fencing design itself (90 s lease, 20 s heartbeat, 30-min attempt cap, ≤3 attempts, superseded uploads retired in the same transaction) is sound. The worker publish path depends on the ledger (F2) being active. Server export admission (`admitServerExport`) bounds dimensions, fps, frames, clips, keyframes, and audio schedules before any work; ffmpeg is spawned with argument arrays and `-protocol_whitelist file,pipe`, `-format_whitelist`; stderr is bounded. No command-injection or SSRF path found.
- **Test:** disposable DB: enqueue with clock advanced → reaper fails the job and refunds seconds; two concurrent `claim_durable_render` never return the same job.

### F4 — Access control is fail-closed but is a hard-coded allowlist in two places, with single-user workspaces — **High for launch / Confirmed**

- **Where:** SQL `demo_private.beta_user_allowed()` and TS `BETA_EMAILS` in `src/lib/auth/beta-policy.ts` both enumerate the two emails; `privateBetaEnabled()` is true whenever `NODE_ENV=production`, so production can never leave beta without a code change. `PRIVATE_BETA_PLAN` in `get-workspace-plan.ts` grants pro-tier limits to everyone in beta.
- **Confirmed correct:** proxy → `getServerClient` → RLS chain; `betaClaimsMatch` requires `amr` containing `oauth`; DB trigger rejects non-allowlisted or non-Google sign-ups; every `public` table carries a RESTRICTIVE `beta_admission` policy. Black-box: 401/redirect on every protected surface.
- **Blocking launch:** (1) removing the allowlist is a migration across every table's RESTRICTIVE policy plus a code change; keep the two in one reviewed change with RLS tests. (2) `workspace_members` is SELECT-only with no invitation/role RPC; `handle_new_user_workspace` creates one personal workspace per user. (3) `GRANT SELECT, UPDATE ON workspaces TO authenticated` is table-wide: an owner can set `owner_id` to any UUID (the policy's WITH CHECK re-tests the *membership row*, not the column). Harmless today; replace with `GRANT UPDATE (name)` before adding plan/tier columns. (4) `/api/projects` resolves the workspace with `.limit(1)` on membership, which breaks silently once users belong to more than one workspace (the route's own comment acknowledges this).

### F5 — Narration admission is correct but sized for two people — **High for launch / Confirmed**

- **Code + DB:** cloud requests always use DB RPC admission (never the local fallback); `narrationRequestId` requires a UUID `Idempotency-Key`; every RPC takes `FOR UPDATE` on the single `narration_gate` row (`lock_timeout=3s`); global cap 2 active; 1 active per actor; 20 attempts / 30,000 chars / 100 MB per actor-hour; `narration_usage` refuses new actors at 1,000 rows; `narrationFailureOutcome` maps provider responses to `failed` (refund) and transport loss to `unknown` (no refund). Multi-instance bypass is impossible because admission is in Postgres.
- **Impact at scale:** "busy" for anyone beyond two concurrent users product-wide; lock-timeout errors under bursts; 1,000-actor ceiling; spend bounded only by the ElevenLabs key's 10,000-credit period quota. No per-workspace allowance, no metering for billing, no provider reconciliation.
- **Fix:** per-workspace gate rows or advisory locks; configurable global concurrency; `plan_limits` table; monthly usage ledger written in `narration_charge`; daily reconciliation with the ElevenLabs usage endpoint; pricing = included allowance + metered overage (list ≈ $0.10/1k chars multilingual, $0.05 flash) + BYOK for enterprises.

### F6 — No error monitoring, alerts, log retention beyond 1 day, or WAF rules — **Medium (High before launch) / Confirmed**

- Sentry code is present and PII-scrubbing (`scrub.ts` strips cookies, auth headers, bodies, query strings) but inert without a DSN. Vercel Pro keeps runtime logs 1 day; no drain; no firewall rules; scanners already probe `/.env`, `/xmlrpc.php`, `/wp-content/`.
- **Fix:** set the DSN (server + client), add a log drain, Vercel Spend Management, Supabase spend alerts, ElevenLabs usage alert, Firewall rate limits on `/api/narration/*`, `/api/storage/*`, `/auth/*`.

### F7 — Database capacity and recovery posture are beta-sized — **Medium / Confirmed**

- Micro compute (60 direct / 200 pooler); `service_role` has **no** `statement_timeout` (`authenticated` 8 s, `anon` 3 s); daily backups exclude Storage objects; PITR off.
- **Fix:** `ALTER ROLE service_role SET statement_timeout='30s'`; Small/Medium before launch; PITR when revenue exists; nightly bucket replication; one timed restore drill into a disposable project.

### F8 — Billing routes dormant; fail closed — **Low / Confirmed fail-closed** (downgraded from Medium)

- `checkout` returns 404 during private beta or when unconfigured and is owner-only; `webhook` returns 404 without config, reads the raw body, verifies `webhook-id/timestamp/signature` with HMAC-SHA256, constant-time compare and a 300 s replay window before parsing, and applies `polar_event_at` recency in `syncSubscriptionEvent`.
- **Gap for activation:** no `polar_event_id` uniqueness ledger, so a replayed event inside the 300 s window with an equal timestamp is idempotent only by upsert semantics. Add the ledger when Polar goes live.

### F9 — CSP allows inline scripts; fixed localhost origin; `x-powered-by` present — **Low / Confirmed**

- `next.config.ts` builds `script-src 'self' 'unsafe-inline'` and `connect-src` including `http://127.0.0.1:47655` on every page; `poweredByHeader` is not disabled.
- **Fix:** nonce-based CSP from the proxy; scope the localhost origin to `/projects/new`; `poweredByHeader: false`.

### F10 — Dev-only pages and the FS storage route ship in the production bundle — **Low / Confirmed fail-closed**

- Proxy returns 404 for `/dev*` and `/api/storage/dev/` in production; the FS route itself also 404s unless `isFsStorageEnabled()` (dev/test only). Verified in code; `/dev/parity` 404 verified black-box.
- **Fix (hygiene):** exclude from production builds to shrink surface and bundle.

### F11 — Client-writable `recording_storage_key` is neutralised on read but is still a write-side smell — **Low / Confirmed** (replaces the earlier, incorrect "dead trigger" claim)

- **Correction:** the previous version of this report said `authenticated` had no UPDATE on `projects`, making `storage_guard_recording_pointer` dead code. That was wrong. Migration 0014 grants **column-level** UPDATE and the client autosaves `doc`, `title`, `resolution`, `duration_frames`, `recording_type`, `recording_storage_key`, `updated_at` directly through PostgREST (`postgrest-provider.ts:194`, `:207`, `:382`). The trigger is live; it is simply a no-op while the lifecycle policy is inactive.
- **Residual risk:** a client can write any string into `recording_storage_key`. On read, `/api/storage/presign` GET passes it through `scopedMediaStorageKey`, which rejects keys outside `ws/{ws}/proj/{proj}/`, so no cross-tenant read. `/api/recording/finalize` HEADs the derived key, not the stored one. The value is therefore harmless but can desynchronise the pointer from the object.
- **Fix:** move the two recording columns to server-owned writes (finalize route already has the service role) and revoke them from the column grant. `projects_document_admission` CHECK is `NOT VALID`; validate it in a migration. Leaked-password protection is off (irrelevant while Google-only; enable anyway).

### F12 — Upload path vs Vercel request body limit — **Info / Confirmed safe**

- Legacy path: browser PUTs directly to the Supabase signed upload URL, never through Vercel. Managed path (inactive): server writes capped at 4 MiB (`MAX_MANAGED_PROXY_BYTES`), larger files use signed URLs. Narration source bytes capped at 4 MiB before Vercel's 4.5 MB limit. No path sends large media through a Vercel function. Earlier concern **withdrawn**.

### F13 — Verification gaps in the repo's own tooling — **Medium / Confirmed**

- `ci.yml` runs the pgTAP RLS job on every PR but the file itself states it is "not wired to branch protection" (a GitHub setting this session cannot read). The RLS suite is the only test that exercises `FOR UPDATE SKIP LOCKED`, `lock_timeout` and cross-tenant policies against real Postgres; it must be a required check.
- `supabase/config.toml` sets `major_version = 15`; production is Postgres 17.6. RLS tests therefore run on a different major version than production.
- The e2e/visual jobs run on `macos-26` runners; the `gate` script depends on them and on ffmpeg. None of that is reproducible in a Linux sandbox without ffmpeg (see §9).
- **Fix:** mark `rls` required; bump `major_version` to 17; add a Linux-only subset of `gate` that CI and auditors can run.

### Positive verifications (no action)

- All 8 `demo_private` tables: RLS on, no grants to `anon`/`authenticated`.
- Every function `SET search_path=''`; SECURITY DEFINER limited to allow-check, workspace bootstrap, and storage tombstone triggers.
- `anon` has no table grants in `public`.
- Client bundle references only `NEXT_PUBLIC_*` env vars (the single `process.env` use under `src/components` is `NEXT_PUBLIC_RECORDER_DOWNLOAD_URL`); service-role key is read only in `config.server.ts` and route handlers.
- `/api/storage/uploads/[id]` claims the write token before reading the body and caps at 4 MiB; `presignPutOnce` and `writeOnce` use `x-upsert: false`.
- PostgREST list queries validate cursors with strict regexes before interpolating into `.or()` filters.
- Sign-out and Google routes check `Origin`; the auth callback validates PKCE state and the redirect origin.

---

## 4. Draft PR #30 (`5ea7206`, "Add automatic recorder import and microphone waveform") — separate findings

Reviewed from the full diff against `main`. Server surface is unchanged (route list identical in both build logs; no migration; no env var). Everything below is client TypeScript or Swift.

**What it does.** Adds AVCaptureSession microphone capture (`MicrophoneCapture.swift`, `MicrophoneSamples.swift`) muxed as an AAC track; an "Open in Demo Pro" action that generates a fresh 32-byte token and opens `https://<origin>/projects/new?capture=desktop#recorder-session=<token>&recorder-quality=…&recorder-expires=…`; browser-side `recorder-session.ts` that restores a session from the URL fragment or `sessionStorage`; `HandoffServer.start(ready:)` and a `sent` callback; `recording-file.ts` accepts `capture.audio` of `"none" | "microphone"`; `Recorder.entitlements` adds `audio-input`; `Info.plist` 0.2.0 + `NSMicrophoneUsageDescription`; e2e and unit specs.

**Findings (draft-only):**

1. **Token-in-fragment handoff is sound — Low / Confirmed.** The token never reaches the server (fragment), the browser strips it from history with `replaceState` before use, `restoreRecorderSession` re-validates origin (HTTPS or localhost), exact 43-char base64url shape, round-trip decode, expiry ≤ 45 min, and never trusts a stored launch URL. `sessionStorage` is tab-scoped and keyed to `scope = user:workspace`. Acceptable. Note the token is only useful against `127.0.0.1:47655` from a page on the allowed origin, so exposure is bounded by the loopback server's own Origin check.
2. **Allowed origins for the production recorder build — Medium / Confirmed.** `Pairing.swift` requires the launch URL's origin to be in `allowedOrigins`; defaults are `http://localhost:3000` and `http://127.0.0.1:3000`. Production requires `DEMOPRO_RECORDER_ALLOWED_ORIGINS` to include `https://demopro.studio` at build time (`scripts/build.sh`). There is no test asserting the production origin list, and the README says so only in prose. Add a build check.
3. **Unbounded PCM backlog is guarded — Info.** `CaptureSession` fails the recording if the PCM backlog exceeds 1 s and flushes every 1 s; the level meter is "preview only". No unbounded arrays found.
4. **Handoff server completion callback — Low.** `sendChunk` now calls `sent(url)` on `remaining == 0`, but the pre-existing `guard Date() < pairing.expiresAt` check runs *after* the zero check, so a transfer that completes exactly at expiry still reports success. Harmless; reorder for clarity.
5. **`DesktopRecording.tsx` retry semantics — Low.** Import failure no longer re-polls the same file (good); failures are surfaced after 3 attempts and polling slows to 3 s after 10. The `follow()` loop exits on expiry and clears the stored session. The `queueMicrotask` hydration guard avoids server-render state changes. No issue.
6. **Release blocker (process, not code):** `STATE.md` in the branch says "NOT RELEASED: physical microphone test awaits" and the 5–10 s unexpected stop has no established cause. Keep the PR draft until three ≥5-minute physical captures with mic on succeed on the hardware that reproduced the stop, with `os_log` attached.
7. **Signing:** still ad-hoc. Gatekeeper will block on other Macs; do not distribute beyond the two beta machines until Developer ID + notarization exist.

Rollback remains a plain revert: no DB or Vercel config changes.

---

## 5. Infrastructure checks not performable from this session

- Dashboard-only settings: Supabase org plan/compute add-on/Spend Cap/backup list/PITR/Auth provider toggles/custom SMTP/JWT expiry/network restrictions/SSL enforcement; Vercel Spend Management, function `maxDuration`/memory, cron (`vercel.json` absent from the repo), Deployment Protection bypass tokens, team roster and 2FA; GitHub branch protection (whether `rls` is a required check).
- ElevenLabs dashboard: plan, credit consumption, key scopes (env var comment is the only attestation).
- Google Cloud OAuth client ownership and redirect URIs; domain registrar for `demopro.studio`; Apple Developer account.
- Execution: `npm run gate` (needs macOS runners + ffmpeg), `npm run test:rls` (needs Docker + Supabase CLI), Swift tests (needs macOS). See §9 for what was run.

---

## 6. Capacity and cost model

**Measured beta baseline (2026-09-15 → 09-23):** 2 users, 26 projects, 236 assets, 413 MB stored (72% audio, 15% PNG); average asset 1.75 MB, max 23 MB; average project document 9.9 KB (max 30 KB); 28 successful TTS generations = 35,277 characters plus 3 transcriptions (519 KB); ~160 Supabase API requests and ~155 Vercel requests per day.

**Official inputs (retrieved 2026-09-23):**
- Supabase compute (docs `platform/compute-and-disk`): Micro ~$10/mo (60 direct / 200 pooler), Small ~$15 (90/400), Medium ~$60 (120/600), Large ~$110 (160/800), XL ~$210. Pro plan $25/mo with $10 compute credit. Egress 250 GB included, then $0.09/GB. Daily backups 7 days on Pro (no Storage objects); PITR 7-day ≈ $100/mo. File storage $0.021/GB-month after 100 GB.
- Vercel Pro (docs `plans/pro-plan`, `functions/limitations`): $20/seat with $20 credit; 1 TB transfer, 10 M edge requests; 4.5 MB request body; Fluid compute default max duration 300 s; 1-day log retention.
- Cloudflare R2 (`developers.cloudflare.com/r2/pricing`): $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, egress $0.
- ElevenLabs API (`elevenlabs.io/pricing/api`; confirm on page): ≈ $0.10/1k chars (Multilingual v2/v3), ≈ $0.05 (Flash/Turbo); Scale $299 ≈ 1.8 M credits; Business $990 ≈ 11 M credits.

**Workload assumptions:** editing is browser-local; the server sees saves (10–30 KB), PostgREST reads, signed-URL issuance, direct-to-storage uploads, narration calls. WAU 20%; ~30 MB assets per session; save every ~30 s; 10 narration generations/user/month at 1,300 chars; 5 projects/user at ~16 MB plus 50–200 MB recordings for a third of projects.

| Scenario | Concurrency (edit / upload / AI / export) | Storage yr-1 | Egress/mo | Infra $/mo | AI $/mo (list) | Binding constraints today |
|---|---|---|---|---|---|---|
| **A. Beta (2 users)** | 2 / 1 / 1 / 1 | <1 GB | <5 GB | Vercel $20–40 + Supabase $25 ≈ **$45–65** | ElevenLabs $22–99 | none |
| **B. One 500-seat enterprise** (100 WAU) | 30 / 5 / 3 / 2 | 150–400 GB | 60–150 GB | Vercel $40–80, Supabase $25 + Small/Medium $15–60 + storage $1–6 ≈ **$85–170** | 6.5 M chars → **$325–650** (Business tier) | narration cap 2 (F5); single-user workspaces (F4); no SSO; storage quota not verified (F2) |
| **C. 3 enterprises + 3,000 individuals** (~900 WAU) | 250 / 30 / 15 / 10 | 1–3 TB | 0.5–2 TB → $25–160 over quota | Vercel $100–300, Supabase $25 + Medium/Large $60–110 + storage $20–60 + egress $25–160 + PITR $100 ≈ **$330–750** | 58 M chars → **$2,900–5,800** | pooler clients; narration lock contention and 1,000-actor cap; no render worker; 1-day logs |

**Take-aways:** infrastructure is cheap at every stage; **narration is the dominant cost** and must be priced into plans. Egress, not storage, is the first Supabase overage; R2 behind the existing adapter removes egress cost (uploads already go direct). Server rendering belongs on a small dedicated worker claiming from `render_queue`, not on Vercel functions. Do not rewrite: the architecture scales to stage C with compute upgrades and §7.

---

## 7. Staged remediation plan

**Immediate (this week, beta stays open):**
1. Migration: revoke `INSERT` (and consider `DELETE`) on `render_jobs` from `authenticated`; drop `render_jobs_insert_member`; switch the dev enqueue insert to the service-role client; update `rls_4_render_jobs_test.sql` (F1).
2. `ALTER ROLE service_role SET statement_timeout='30s'` (F7).
3. Set the Sentry DSN, add a Vercel log drain, Spend Management, Supabase spend alerts, ElevenLabs usage alert (F6).
4. Make the `rls` CI job a required check; bump `supabase/config.toml` to Postgres 17 (F13).
5. One restore drill of the DB into a disposable project and one bucket copy; record RPO/RTO (F7).

**Pre-public-launch:**
6. Replace both allowlists (SQL + `beta-policy.ts`) with a table-driven gate; make `privateBetaEnabled()` configuration, not `NODE_ENV`; fix the `.limit(1)` workspace resolution (F4).
7. Activate the storage lifecycle ledger after a staging inventory review, or add an interim library-asset finalize step; use no-upsert signed URLs for new keys (F2). Move the recording pointer columns to server-owned writes (F11).
8. Re-size narration admission and decide the offering (F5).
9. Workspace membership: invitations, roles, removal, RLS tests; column-level grant on `workspaces` (F4).
10. Vercel Firewall rate limits; nonce CSP; `poweredByHeader: false`; strip dev routes from production builds (F6, F9, F10).
11. Supabase compute → Small/Medium; PITR; bucket replication (F7).
12. Billing: add `polar_event_id` uniqueness before enabling Polar (F8).
13. Data-deletion workflow and retention policy (FK cascades exist; add object purge via ledger cleanup RPCs).
14. Render worker (if server export is needed): queued-row reaper first, then a persistent host with ffmpeg (F3).

**Enterprise (later):**
15. SSO (Supabase SAML), SCIM (custom), append-only audit table, per-workspace retention, DPA/subprocessor list, optional regional projects, customer-managed narration keys, admin console.

---

## 8. Service-ownership migration checklist (Ranger & Fox → Demo Pro)

Confirmed today: GitHub repo under personal account `steve-rangerandfox`; Vercel team `steve-rangerandfoxs-projects` (also hosts Kit and other R&F projects); Supabase org `jgqbmyajtgdevofgnqvg` (also hosts Kit, talenthub, Social Studio, Founder OS); ElevenLabs key "Demo Pro Production"; domain `demopro.studio` verified on Vercel (registrar unknown); Google OAuth client (owner unknown); Apple signing ad-hoc. Proposed/unconfigured: R2, Polar, Sentry, log drains.

1. **Create Demo Pro entities:** GitHub org, Vercel team (Pro), Supabase org (Pro), Cloudflare account, Google Cloud project, ElevenLabs workspace, Apple Developer Program, Sentry org. Shared password manager, `security@demopro` recovery group, 2FA everywhere.
2. **Repository:** transfer to the new org (GitHub redirects); re-install the Vercel Git integration; rotate any CI PATs. Note `authRedirectOrigin` is hard-coded to `https://demopro.studio`, so the domain must move with the project.
3. **Supabase:** Project Transfer (docs `platform/project-transfer`) keeps ref, URL, keys, data, Auth users; then rotate the service-role key and DB password and update Vercel env.
4. **Vercel:** Project Transfer request → accept from the new team; re-add sensitive env values if dropped; verify `demopro.studio`; keep the old team until the first green production deploy.
5. **Google OAuth:** new client in the Demo Pro GCP project; register the Supabase callback; run both clients for a week; `auth.identities` keys on provider `sub`, so accounts persist.
6. **ElevenLabs:** new workspace and scoped key; update Vercel env; revoke old key.
7. **Domain/DNS:** transfer registration; replicate DNS in the new zone first, then switch nameservers.
8. **Backups before each step:** logical dump + bucket copy; verify restore.
9. **Ownership verification:** ≥2 owners per service; old accounts removed; production smoke test (login, project load, signed URL, narration).
10. **Rollback:** every transfer is reversible within the provider's window; keep sealed old credentials until the post-transfer week is clean.

---

## 9. Test commands, results, coverage gaps

Run in this session against the clone at `d6398174` (Node 22.22.2, npm 10.9.7, Linux sandbox, no ffmpeg, no Docker):

| Command | Result |
|---|---|
| `npm ci` | **Pass** (exit 0; postinstall mediabunny patch applied; deprecation warnings only) |
| `npm run lint` | **Pass** (0 errors, 17 warnings: `<img>` usage in editor components, three unused `_` params in a billing test) |
| `npm run typecheck` (`next typegen` + `tsc --noEmit`) | **Pass** (exit 0) |
| `npm run test:unit` (Playwright unit tier, 2,524 tests) | **Partial**: started in the sandbox; at the 10-minute session budget roughly 250 of 2,524 tests had run with no failures reported. The tier runs single-worker under Chromium here and is too slow to complete inside the session; the reported 2,527-test count is consistent with the discovered 2,524. Treat as *not independently completed*. |
| `npm run gate` | Not run: requires ffmpeg and the macOS-only visual/e2e tiers |
| `npm run test:rls` | Not run: requires Docker and the Supabase CLI |
| Swift tests | Not run: requires macOS |

Also run (read-only): Supabase SQL (policies, functions, grants, triggers, constraints, indexes, counts, orphan analysis, role settings; §10), Supabase 24 h log queries and advisors, Vercel project/env names/domains/deployments/build logs/runtime logs/firewall, production HTTP checks (`/`→200, `/login`→200 Google-only, `/projects`,`/learn`→redirect, `/dev/parity`→404, all tested API routes→401, `/robots.txt`→`Disallow: /`).

**Coverage gaps even when everything passes:** the unit tier runs on PGlite in one session and cannot exercise `FOR UPDATE SKIP LOCKED`, `lock_timeout`, or two-session races in `claim_durable_render`, `narration_reserve`, `reserve_storage_object`; only the pgTAP `rls` job does, on Postgres 15 rather than 17, and it is not a required check (F13). There is no test asserting the production origin list of the recorder build (PR #30 finding 2). There is no test for the `render_jobs` forged-row cases in F1 because current tests assert the opposite.

---

## 10. Appendix — key evidence queries (safe to re-run read-only)

```sql
-- grants that let clients write
select grantee, table_name, string_agg(privilege_type, ',') from information_schema.role_table_grants
 where table_schema='public' and grantee in ('anon','authenticated') group by 1,2 order by 2,1;
-- column-level grants (F11)
select table_name, column_name, privilege_type from information_schema.role_column_grants
 where grantee='authenticated' and table_schema='public' order by 1,2;
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

Proposed regression tests (disposable Postgres via the repo's `test:rls` harness, or route tests):
1. `authenticated` INSERT into `public.render_jobs` → `42501` (after F1).
2. Two sessions calling `claim_durable_render` concurrently receive distinct jobs; `finish_durable_render` with a stale attempt returns false.
3. Three concurrent `narration_reserve` for three actors: two `reserved`, one `busy` (pre-fix); assert the configured cap after re-sizing.
4. `reserve_storage_object` → `not_activated` while inactive, `reserved` after activation, `quota` when exceeded; `observe_storage_object` with mismatched bytes → `cleanup_pending`.
5. Non-allowlisted Google user: `auth.users` insert raises; allowlisted user with a JWT lacking `amr:oauth` sees zero rows.
6. Route: `/api/storage/presign` GET with a `recording_storage_key` pointing outside the project prefix → 404 (already true via `scopedMediaStorageKey`; pin it).
7. Recorder build: `Info.plist` allowed origins contain exactly `https://demopro.studio` for release builds.

## 11. Code-confirmation checklist — outcomes

| # | Item | Outcome |
|---|---|---|
| 1 | `src/proxy.ts` gating; `/dev/**`, `/api/storage/dev/**` 404 in prod | **Confirmed** |
| 2 | `config.server.ts` fail-closed; Polar/R2/Sentry optional | **Confirmed** (service-role missing → 500 with log; Polar/billing → 404; R2 only with full config; Sentry gated on DSN) |
| 3 | `/api/render/download` key derivation; `/api/render/enqueue` fail-closed | **Confirmed** both |
| 4 | Storage size caps, content-type, write modes, `size_bytes` provenance | **Confirmed**; residual gap F2 (library asset actual size never observed in legacy mode) |
| 5 | `/api/billing/webhook` signature before parse; secret missing | **Confirmed** (404 when unconfigured; verify then parse) |
| 6 | `/api/narration/*` body limits vs 4.5 MB; cancellation; `unknown` outcome | **Confirmed** (4 MiB cap; 90 s abort propagated; `unknown` never refunds) |
| 7 | Client bundle secrets | **Confirmed** none |
| 8 | Recorder loopback, origin, per-launch secret, package validation, signing | **Confirmed** loopback/origin/secret/validation; signing ad-hoc |
| 9 | CI: gate on PRs, RLS on real Postgres, secrets not echoed | **Confirmed** with caveats F13 (RLS not required; PG15 vs 17) |
