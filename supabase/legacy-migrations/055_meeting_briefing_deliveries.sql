-- 055_meeting_briefing_deliveries.sql
-- Per-recipient delivery ledger for pre-meeting briefings.
--
-- Incident: the Oshi briefing was sent twice. Root cause: preMeetingDispatch
-- posted to Slack inside a retryable Inngest step with no per-recipient claim,
-- so a step retry (Slack accepted the post but the 8s client fetch timed out,
-- or Inngest re-ran the step) re-posted the same briefing. `notified_user_ids`
-- was only written AFTER posting, so it was an audit trail, not a guard.
--
-- This ledger makes each (occurrence, internal recipient) delivery an atomically
-- claimed row and the SINGLE authoritative source of delivery state. It replaces
-- meeting_briefings.notified_user_ids as the truth (that column is no longer
-- written; no code reads it).
--
-- Identity: keyed to the canonical occurrence row (meeting_briefings.id) and the
-- authoritative internal recipient (staff.id) — NOT slack_user_id, which can be
-- reassigned. fetchUpcomingEvents uses singleEvents:true, so meeting_briefings
-- holds one row per expanded occurrence; the FK is therefore occurrence-scoped
-- and provider-agnostic.
--
-- State machine (per row):
--   pending -> claimed -> (posting) -> sent           (terminal, delivered)
--   claimed/posting + expired lease -> reclaimable    (crash-after-claim recovery)
--   post attempted, no ack (timeout/network) -> unconfirmed  (indeterminate)
--        -> reconcile via Slack message metadata -> sent, or re-post
--   definitive Slack error -> failed                  (retryable by Inngest)
--
-- Delivery is at-least-once + metadata reconciliation ≈ effectively-once. It is
-- NOT exactly-once: Slack chat.postMessage exposes no idempotency key, so the
-- `unconfirmed` state + conversations.history metadata lookup is the only
-- reconciliation the provider boundary allows.

begin;

create table if not exists public.meeting_briefing_deliveries (
  id uuid primary key default gen_random_uuid(),
  meeting_briefing_id uuid not null
    references public.meeting_briefings(id) on delete cascade,
  internal_recipient_id uuid not null
    references public.staff(id) on delete cascade,
  -- Denormalized delivery target (the channel/user Kit actually posts to). The
  -- authoritative recipient identity is internal_recipient_id; this is a cache
  -- so the dispatcher need not re-resolve staff to post.
  slack_user_id text not null,
  slack_channel_id text,
  slack_message_ts text,
  status text not null default 'pending'
    constraint meeting_briefing_deliveries_status_check
    check (status in ('pending', 'claimed', 'posting', 'unconfirmed', 'sent', 'failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One delivery row per (occurrence, internal recipient). With the compare-and-
  -- set claim this guarantees EXCLUSIVE PROCESSING — a retry/re-scan cannot
  -- create a second delivery row and only one worker acts at a time. It does NOT
  -- by itself guarantee a single Slack message: effectively-once delivery also
  -- depends on metadata reconciliation before any repost (see briefing-delivery.ts).
  constraint meeting_briefing_deliveries_recipient_key
    unique (meeting_briefing_id, internal_recipient_id)
);

-- Stale-claim recovery scan: find claimed/posting rows whose lease has expired.
create index if not exists meeting_briefing_deliveries_reclaim_idx
  on public.meeting_briefing_deliveries (status, lease_expires_at);

comment on table public.meeting_briefing_deliveries is
  'Authoritative per-recipient delivery state for pre-meeting briefings. One row per (meeting_briefings.id, staff.id). Replaces meeting_briefings.notified_user_ids as the source of truth.';

commit;
