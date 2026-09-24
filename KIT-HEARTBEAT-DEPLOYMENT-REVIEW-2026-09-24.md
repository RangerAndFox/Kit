# Railway Cron Heartbeat — patch review, staged deployment & rollback

**Branch:** `claude/kit-independent-audit-4yknn1` (review only — **not merged, not deployed**)
**Change:** schedule-aware, attempt-vs-success cron heartbeat telemetry for Railway node-crons, surfaced by the existing Vercel health watchdog.

## 1. What changed (files)

| File | Change |
|---|---|
| `supabase/migrations/20260924150000_cron_heartbeat_attempts.sql` | Adds nullable `last_attempt_at`; makes `last_success_at` nullable and drops its `now()` default. |
| `src/types/supabase.ts` | Reflects the migration in the generated `cron_heartbeats` type (what a post-migration regen produces). |
| `src/lib/health/state.ts` | `loadHeartbeats` returns `{success, attempt}`; new `recordCronAttempt`; `recordCronSuccess` now stamps both. |
| `src/lib/health/cron-schedule.ts` (new) | Pure, DST-correct tz math: `tzOffsetMs`, `zonedTimeToUtc`, `zonedParts`, `mostRecentScheduledFire`. |
| `src/lib/health/probes.ts` | `CRON_SPECS` registry (interval **and** daily/weekday specs); rewritten `checkCronFreshness` with attempt/success, schedule-awareness, startup grace, feature gating. |
| `src/lib/health/run.ts` | Passes a boot timestamp for startup grace. |
| `bolt/src/cron-heartbeat.ts` | `stampCronAttempt` / `stampCronSuccess` (best-effort, never throw into a cron). |
| `bolt/src/app.ts` | 11 Railway crons stamp attempt-at-start + success-on-completion; behance/elevenlabs truthfulness bug fixed; 3 weekday/daily crons newly monitored. |
| `src/lib/health/{cron-schedule,freshness}.test.ts` | 20 new tests (DST/weekend/tz, attempt-vs-success, startup grace, disabled features, schedule-aware). |

**Validation on this branch:** root `tsc` clean · bolt `tsc` clean · `check-migrations` 119 files OK · `lint:ratchet` flat (no new debt) · bolt vitest **961 pass** · health suite **50 pass**.

## 2. Truthful success reporting — review

**Contract:** `stampCronAttempt` records the tick *started*; `stampCronSuccess` is called **only inside the job's own `.then`**, so a rejected job promise skips it. "Success" therefore means *the cron's pass completed without an infrastructure-level throw* — it does **not** claim every item succeeded. Per-item failures these jobs deliberately catch-and-tally are surfaced by their own ledgers and the integration probes (e.g. the `dropbox-inbox` dead-letter probe), not by the heartbeat.

**Bug found and fixed.** The prior draft wrapped `behance-elevenlabs-sync` in `Promise.allSettled([... .catch()])` and stamped success unconditionally — so a real failure (even the initial `listUnsyncedBehanceDrafts()` DB query throwing) would have been reported as success. Rewritten to `Promise.all` with **no inner `.catch`**, success stamped only on resolve, failure logged in a trailing `.catch`. Now truthful.

**Per-cron inner-error review** (does an infra failure reject → skip success stamp?):

| Cron | Infra failure behavior | Success stamp truthful? |
|---|---|---|
| `behance-elevenlabs-sync` | `listUnsyncedBehanceDrafts()` awaited un-caught → rejects; per-row Slack errors caught & tallied | ✅ (after fix) |
| `dropbox-inbox-sweep` | `processDropboxNotification`/`drainDropboxInbox` reject on infra error → `.catch`, no stamp | ✅ |
| `project-share-recovery` | `reconcilePendingProjectShares` rejects on infra error; per-item failures returned in `{failed}` | ✅ (pass-level) |
| `project-control-recovery` | `runProjectControlRecoverySweep` rejects → `.catch`, no stamp | ✅ |
| `missed-checkin-reply-recovery` | rejects on infra error → no stamp | ✅ |
| `daily-hours-reminder` | `sweepDailyReminders` rejects on infra error → no stamp | ✅ |
| `frameio-project-link-reconcile` | rejects on infra error → no stamp | ✅ |
| `ae-render-notify` | dynamic import + notify reject → no stamp | ✅ |
| `pending-checkin-nudge`, `missing-time-scan`, `daily-celebrations` | reject on infra error → no stamp | ✅ (pass-level) |

**Known, documented limitation:** the 5 Vercel/Inngest crons still stamp success-only (no attempt), so for *them* the watchdog cannot distinguish "failing" from "not running" — it only knows "no recent success." Adding attempts there is a follow-up (their runners live in `src/lib/inngest/delivery-crons.ts`), out of this change's scope.

**Startup grace / never-seen:** a never-stamped cron is held green for `STARTUP_GRACE_MIN` (30) after the watchdog's boot, and a weekday cron is green until its fire + grace — so a deploy or cold start doesn't false-red before the first tick. After that window it fails closed (`no heartbeat recorded`).

## 3. Migration safety

`last_attempt_at` is additive + nullable. `last_success_at` loses NOT NULL/default, but **every existing row already has it set**, and the only writer (`recordCronSuccess`) always provides it explicitly — so **currently-deployed (old) code keeps working unchanged** against the migrated table. The migration is therefore safe to apply *before* any code deploy.

## 4. Staged deployment order (exact)

> Each stage is independently safe with the *previous* stage's code still running. Do not skip the order: it prevents transient false-reds and "column does not exist" errors.

1. **Apply the migration** `20260924150000_cron_heartbeat_attempts.sql` (Supabase).
   - Old Railway/Vercel code is unaffected (see §3). Nothing reads/writes `last_attempt_at` yet.
2. **Deploy Railway (Bolt)** — the writers (`state.ts`, `cron-heartbeat.ts`, `app.ts`).
   - Railway begins stamping `last_attempt_at` (needs the column from step 1) and `last_success_at`.
   - Vercel is still on old code: its watchdog checks only the original 5 crons and ignores the new ids and the new column. No user-visible change yet.
3. **Deploy Vercel** — the watchdog (`probes.ts`, `run.ts`, `state.ts`, `cron-schedule.ts`, `types`).
   - The watchdog now reads `last_attempt_at` and checks the new cron ids. Because Railway (step 2) has been stamping for a while, the new rows are already green; startup grace covers any residual.

**Why not Vercel-before-Railway:** Vercel's new registry expects heartbeats for ids Railway hasn't stamped yet → they'd show red (or "awaiting") until Railway ships. Railway-first avoids that.

## 5. Verification checks (per stage)

**After step 1 (migration):**
```sql
select column_name, is_nullable, column_default
from information_schema.columns
where table_name = 'cron_heartbeats';   -- last_attempt_at present; last_success_at nullable, no default
select count(*) from cron_heartbeats where last_success_at is null;  -- expect 0 (existing rows intact)
```

**After step 2 (Railway):** within ~3 minutes,
```sql
select cron_id, last_attempt_at, last_success_at,
       round(extract(epoch from (now()-last_attempt_at))/60,1) as attempt_min,
       round(extract(epoch from (now()-last_success_at))/60,1) as success_min
from cron_heartbeats
where cron_id in ('dropbox-inbox-sweep','project-share-recovery','missed-checkin-reply-recovery',
                  'ae-render-notify','behance-elevenlabs-sync','project-control-recovery')
order by cron_id;
```
Expect both timestamps advancing (< ~2 min for the every-minute crons). Grep Railway logs for `[cron-heartbeat] ... stamp failed` (should be none). The weekday crons (`pending-checkin-nudge`, `missing-time-scan`) won't stamp until their next 09:00 local fire — that's expected.

**After step 3 (Vercel):** load `/status` (or run the watchdog) and confirm:
- the new `cron:*` rows render **green** with `last success Nm ago`;
- no row shows `not running` / `attempting but not succeeding` falsely;
- feature-gated rows behave (no `cron:daily-celebrations` unless `KIT_TEAM_CHANNEL_ID` is set; no `cron:drive-transcript-scan` unless enabled).

**Negative test (optional, staging):** stop stamping one cron (or set its heartbeat back) and confirm it flips to `not running`, and that a fresh attempt with a stale success reads `attempting but not succeeding`.

## 6. Rollback plan

- **Vercel:** redeploy the previous Vercel build. The watchdog reverts to checking only the original 5 crons; the extra heartbeats are simply ignored. No data cleanup.
- **Railway:** redeploy the previous Bolt build. Stamping stops; `last_attempt_at` just stops advancing. Harmless.
- **Migration:** **recommended to leave in place** — it is additive and nullable and does not affect old code. If a strict schema rollback is mandated, first ensure no attempt-only rows exist, then:
  ```sql
  delete from cron_heartbeats where last_success_at is null;   -- only attempt-only rows
  alter table cron_heartbeats alter column last_success_at set default now();
  alter table cron_heartbeats alter column last_success_at set not null;
  alter table cron_heartbeats drop column last_attempt_at;
  ```
  Do this **only** with both app tiers already rolled back, or the running code will error on the missing column.

Rollback is safe at any stage and in any order **after** the code tiers are reverted; the migration need not be reverted at all.

## 7. Surfaces still requiring manual, in-console verification (not accessible here)

These were **not** verified and must not be treated as green:

- **Railway live process + `/health`:** the endpoint is proxy-blocked from the audit environment, and (until this patch deploys) Railway emits no heartbeat. Confirm from inside the network: `GET https://kit-production-d273.up.railway.app/health` returns healthy, and the Railway dashboard shows the running deployment SHA matches `main`. After this patch deploys, the heartbeats in §5 become the durable signal.
- **`CHECKIN_TIMEZONE` parity:** the weekday specs assume `America/Los_Angeles` (the code default). If Railway sets `CHECKIN_TIMEZONE` to something else, set the **same** value on Vercel (the watchdog) so its 09:00 fire math matches; otherwise the nudge/missing-time freshness windows will be off by the tz delta.
- **Apps Script (Google Sheet `1qF690…`):** the bound Apps Script — its triggers and the HMAC secret it signs `/api/webhooks/project-control/sheet-edited` with — is **not readable via any connector in this session** (Drive exposes the spreadsheet, not its bound script). Verify manually in Extensions → Apps Script: the `onEdit`/installable triggers exist and are enabled, the shared secret matches `PROJECT_CONTROL_WEBHOOK_SECRET`, and no code still references the deprecated workbook `1K-P4yCU…`.
