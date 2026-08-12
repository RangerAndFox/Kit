# Daily health check

Confirm Kit's production surface is actually running — integrations reachable,
crons firing, and (the priority) **time is still logging to Harvest**. The
class of failure this exists to catch is the one that hid for months: a cron or
confirm path that silently stops without erroring, so nobody notices until
hours go missing. See `.ai/invariants.md` #5, #7, #8, #11.

Cadence: once daily. Read-only by default — this check **diagnoses**, it does
not write to Harvest or mutate state. Any remediation is a separate, confirmed
action (see "If something is red").

Kit runs an automated version of this itself: the `healthDailyDigest` Inngest
cron (`src/lib/inngest/health-digest.ts`) DMs the owner a one-glance digest at
09:00 America/New_York — the same probes plus the time-logging roll-up below.
This runbook is the deeper manual pass (for when the digest flags something, or
for an on-demand check); the digest is the daily heartbeat.

## What to check

Run these top to bottom. Each names the exact tool and what "green" looks like.
Prefer the direct Supabase queries — they are the source of truth the
`/api/status` page and `healthWatchdog` cron both read, and they do not depend
on guessing a deploy URL.

Kit Supabase project ref: `ozsxrcgrezpffnpwlrnq`.

### 1. Integration probes (Dropbox, Frame.io, Harvest, Supabase, Google)

The `healthWatchdog` cron writes each probe's result to `system_health`. Read
the latest:

```sql
select key, status, detail, since, checked_at
from system_health order by status desc, key;
```

Green: every row `status='up'`. Also confirm `checked_at` is recent (within the
watchdog interval) — a stale `checked_at` means the watchdog itself stopped,
which is a red even if every row still says `up`.

Equivalent HTTP check (external monitor): `GET /api/status` on the production
Vercel app returns 200 when all green, 503 when anything is down.

### 2. Cron freshness

```sql
select cron_id, last_success_at, now() - last_success_at as age
from cron_heartbeats order by last_success_at;
```

Green vs. the limits in `src/lib/health/probes.ts` (`CRON_MAX_AGE_MIN`):
`delivery-dropbox-scan` / `delivery-specs-scan` ≤ 15m, `drive-transcript-scan`
/ `pre-meeting-scan` ≤ 45m. Over the limit = that cron stalled.

### 3. Time-logging integrity — the one we can't get wrong

The 2026 outage: migration 048 — the `'logging'` claim state was missing from
the `daily_hours_checkins` status constraint, so **every** confirm failed
silently and nothing reached Harvest. Watch that exact table.

```sql
-- Acute-bug signature. All three "bad" counts must be 0.
select
  count(*) filter (where status='logged') as logged_total,
  count(*) filter (where status='logged' and (harvest_entry_ids is null or harvest_entry_ids='[]'::jsonb)) as logged_without_harvest_ids,
  count(*) filter (where status='failed') as failed_total,
  count(*) filter (where status='logging') as stuck_in_logging
from daily_hours_checkins
where check_in_date >= current_date - interval '30 days';
```

- `failed_total > 0` → confirms are erroring. Read `error_message` on those rows.
- `stuck_in_logging > 0` → the 048 signature is back (claim state not clearing).
- `logged_without_harvest_ids > 0` → a "logged" row with no audit trail; the
  status advanced without a real Harvest write.

```sql
-- Backlog: replies that never became logged time (lost hours), and any
-- row that has a Harvest id but a status that never advanced (inconsistency).
select
  -- No reply yet: 'sent' OR 'nudged' (a nudge only reminds; it never stamps
  -- reply_ts, so a still-'nudged' row is unanswered, not lost hours).
  count(*) filter (where status in ('sent','nudged') and reply_ts is null) as sent_no_reply,
  -- Replied but never logged — gate on reply_ts (matches digest.ts), so an
  -- unanswered nudge can't inflate this.
  count(*) filter (where status in ('replied','parsed','confirmed','logging') and reply_ts is not null) as replied_but_unlogged,
  count(*) filter (where status='parsed' and harvest_entry_ids is not null) as harvest_id_but_status_stuck
from daily_hours_checkins
where check_in_date < current_date;
```

- `sent_no_reply` is **soft** — the person never answered their DM (whether or
  not it was already nudged); that is their choice, not a Kit fault. Worth a
  follow-up, not an alarm.
- `replied_but_unlogged` is the **real** signal: someone typed hours and they
  never reached Harvest. A steadily rising count over days = the pipeline is
  dropping replies again. Pull the detail rows (`id, slack_user_id,
  check_in_date, status, reply_ts is not null as has_reply, error_message`) to see who.
- `harvest_id_but_status_stuck > 0` → confirm created the entry but failed to
  advance status: double-log risk if anyone re-runs it.

### 4. Deploys carry the latest fixes

- **Vercel** (`mcp__Vercel__list_deployments`, project `prj_fZDzEUdzq8KGhu3lZIFW5B0db5BG`,
  team `team_v7zyTYZNDyI1wXLmAPWbQ3sn`): newest `target=production` deployment
  is `state=READY`, not `ERROR`.
- **Railway** owns the check-in cron + the timezone-cache fix (commit 1d56269,
  `bolt/src/checkins/user-tz.ts`) that stops mistimed DMs — the root cause of a
  whole batch of unlogged hours. Railway deploy state is **not** visible from
  the repo (`.ai/runtime.md`); confirm `main`'s check-in commits are live there
  before trusting that the preventive fix is in effect.

### 5. Supabase advisors (baseline drift only)

`mcp__Supabase__get_advisors` (`security` + `performance`). The Kit project has
a known baseline: `rls_enabled_no_policy` INFO on the service-role-only tables
(by design — see `src/lib/health/state.ts`), plus a few `function_search_path_mutable`
/ `extension_in_public` / `security_definer` WARNs. Report only **new** ERROR/WARN
lints beyond that baseline — do not re-flag the standing set each day.

## If something is red

Diagnose the mechanism before touching anything (`.ai/workflows/debugging.md`):
name the invariant, find the root cause, don't just re-run the job.

- **Stuck/unlogged check-ins** (`replied_but_unlogged` real, or a
  `harvest_id_but_status_stuck` row): the recovery tool is
  `bolt/scripts/recover-stuck-checkins.ts`. Default run is a **read-only
  preview** (parse + resolve, no writes) — safe to run to quantify. `--commit`
  replays into Harvest and **writes real billing data**: it is an irreversible
  external write, so get explicit confirmation before running with `--commit`,
  and prefer `--since` / `--user` to scope it. It only recovers `sent`/`nudged`
  rows with a findable reply; `parsed`-but-unconfirmed rows are a separate gap.
- **A probe down / cron stale:** exercise the real auth path or read the cron's
  logs (`mcp__Supabase__get_logs`, Vercel runtime logs). Fix the credential or
  the job — never widen a timeout or stub the probe green.
- **Anything ambiguous or cross-runtime:** stop and ask (`CLAUDE.md` "Stop and
  ask when"). Do not move work across the Railway/Vercel boundary to "fix" a
  red.

Report the run as a short status: what's green, what's red, and the one
number that matters most day to day — `replied_but_unlogged`.
