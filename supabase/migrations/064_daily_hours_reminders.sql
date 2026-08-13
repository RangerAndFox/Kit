-- 064_daily_hours_reminders.sql
-- Durable occurrence + delivery ledger for the scheduled 5pm daily-hours reminder.
--
-- Incident: Stephen (U4CA7HXT9) received no Friday 2026-07-31 reminder. Root
-- cause was structural, not a one-off: the old sender (bolt/src/checkins/
-- daily-hours.ts) had NO durable occurrence. Eligibility was an exact-hour
-- equality (`localHour === 17`) evaluated only at discrete hourly ticks, the DM
-- was posted BEFORE any row was written, and the tracking row was inserted only
-- AFTER a successful post. So a missed/failed tick, a Railway restart, a
-- transient Slack failure, or a post-before-record crash permanently lost that
-- day's reminder — nothing recorded it as owed, and nothing recovered it.
--
-- Stephen's specific miss was the travel-timezone transition: he flew Pacific ->
-- Eastern on Friday, so his single 5pm-local instant fell BETWEEN two hourly
-- ticks (Pacific 5pm = 00:00 UTC Sat, by then he resolved Eastern = 8pm; Eastern
-- 5pm = 21:00 UTC Fri, at which his cached tz was still Pacific = 2pm). The
-- exact-hour equality had no date-anchored occurrence to catch up, so the day
-- was skipped entirely. (Read-only evidence: the Central 22:00 UTC and Pacific
-- 00:00 UTC cohorts DID receive Friday reminders, and 07-31 was not a holiday,
-- so it was neither a cron outage nor a holiday skip.)
--
-- This ledger makes each (staff, local workday, reminder type) a durable, atomically
-- claimed occurrence and the SINGLE authoritative source of scheduling + delivery
-- state. The conversation record (the DM/reply/parse/log lifecycle) stays in
-- daily_hours_checkins; this table owns WHETHER and WHEN the reminder is owed and
-- delivered. On a successful send the occurrence links the daily_hours_checkins
-- row it created (check_in_id), so every existing reply / confirm / nudge /
-- missing-time path keeps working unchanged.
--
-- State machine (per row):
--   pending -> claimed -> (posting) -> sent            (terminal, delivered)
--   claimed/posting + expired lease -> reclaimable     (crash-after-claim recovery)
--   post attempted, no ack (timeout/network) -> unconfirmed  (indeterminate)
--        -> reconcile via Slack message metadata -> sent, or re-post
--   satisfied by an existing/ad-hoc entry, or window closed -> skipped (terminal)
--   definitive Slack error / no Harvest mapping -> failed  (reclaimable within window)
--
-- Delivery is at-least-once + metadata reconciliation ~= effectively-once. It is
-- NOT exactly-once: Slack chat.postMessage exposes no idempotency key, so the
-- `unconfirmed` state + conversations.history metadata lookup is the only
-- reconciliation the provider boundary allows (mirrors migration 055).
--
-- Rollout ordering: apply this migration BEFORE deploying the Railway code that
-- reads/writes it. The new sweep tolerates the table's absence only if it is
-- deployed after the migration; deploy order is migration-first.

begin;

create table if not exists public.daily_hours_reminders (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  -- Denormalized delivery target (the recipient Kit posts to). Authoritative
  -- recipient identity is staff_id; this is a cache so the sweep need not
  -- re-resolve staff to post, and diagnostics can key on slack_user_id.
  slack_user_id text not null,
  -- The recipient's LOCAL workday (computed in their resolved timezone). This is
  -- the occurrence anchor: keying on the local date — not a wall-clock instant —
  -- is what makes travel-timezone transitions idempotent. 5pm Pacific and 5pm
  -- Eastern on the same calendar day resolve to the SAME local_date, so a tz
  -- shift within the delivery window can never mint a second occurrence.
  local_date date not null,
  reminder_type text not null default 'daily_hours',
  status text not null default 'pending'
    constraint daily_hours_reminders_status_check
    check (status in ('pending', 'claimed', 'posting', 'unconfirmed', 'sent', 'skipped', 'failed')),
  -- The timezone used to compute local_date / eligibility (for diagnostics).
  resolved_timezone text,
  -- The private one-person Kit channel Kit posted to (NOT the Assistant DM —
  -- proactive DMs from an Agents & AI app land in History without notifying).
  slack_channel_id text,
  slack_message_ts text,
  -- The daily_hours_checkins conversation row this occurrence created on send,
  -- so replies / confirm / nudge continue to operate on the check-in lifecycle.
  check_in_id uuid references public.daily_hours_checkins(id) on delete set null,
  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  -- Why a terminal skip happened: 'satisfied_existing' (already logged / open
  -- check-in for the day) or 'window_closed' (recovered after the work-hours
  -- cutoff — do not send stale reminders late at night).
  skip_reason text,
  -- Failure / unconfirmed detail for operator diagnosis. Must never contain
  -- secrets or message bodies — a short reason code / Slack error only.
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One occurrence per (staff, local workday, reminder type). With the compare-
  -- and-set claim this guarantees EXCLUSIVE PROCESSING: two overlapping hourly
  -- sweeps cannot create a second occurrence and only one worker acts at a time.
  -- It does NOT by itself guarantee a single Slack message — effectively-once
  -- delivery also depends on metadata reconciliation before any repost.
  constraint daily_hours_reminders_occurrence_key
    unique (staff_id, local_date, reminder_type)
);

-- Stale-claim recovery scan: find claimed/posting rows whose lease has expired.
create index if not exists daily_hours_reminders_reclaim_idx
  on public.daily_hours_reminders (status, lease_expires_at);

-- Diagnostic / per-recipient-day lookup (the read-only operator diagnostic and
-- the sweep's ensure/expire both key on this).
create index if not exists daily_hours_reminders_lookup_idx
  on public.daily_hours_reminders (slack_user_id, local_date);

comment on table public.daily_hours_reminders is
  'Authoritative durable occurrence + delivery state for the scheduled daily-hours reminder. One row per (staff.id, local workday, reminder_type). Owns whether/when the reminder is owed and delivered; daily_hours_checkins remains the conversation record. Service-role owned (written only via the admin client), consistent with meeting_briefing_deliveries.';

commit;
