-- Shared OAuth state for Plaud's personal-recording API.
--
-- Plaud access tokens expire and refresh responses may rotate the refresh
-- token. Kit runs in multiple serverless instances, so the refresh token must
-- be persisted and exchanges must be serialized. This mirrors the proven
-- Frame.io token-state pattern: one singleton row, a short refresh lease, and
-- service-role-only access.

begin;

create table if not exists public.plaud_token_state (
  id text primary key check (id = 'singleton'),
  refresh_token text,
  access_token text,
  access_expires_at timestamptz,
  refreshing_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.plaud_token_state enable row level security;

-- This table contains credentials. It is intentionally unavailable to the
-- public Data API roles; server-side service-role calls bypass RLS.
revoke all on table public.plaud_token_state from anon, authenticated;
grant select, insert, update on table public.plaud_token_state to service_role;

commit;
