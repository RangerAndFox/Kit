-- 062_frameio_token_shared_access.sql
--
-- Coordinate Frame.io Adobe IMS token refresh across Kit's runtimes.
--
-- Adobe rotates the refresh token on every exchange. Kit runs the Frame.io auth
-- path in more than one runtime at once (Vercel Next.js incl. Inngest + the
-- /status poller, and the Railway Bolt service). Previously each runtime kept its
-- own in-memory copy of the refresh token and refreshed independently, so whenever
-- one exchanged, Adobe invalidated every other runtime's copy -> the loser's next
-- exchange failed with `400 access_denied`. That is why `/v4/me` could be green on
-- one runtime while project provisioning failed on another.
--
-- Fix (no Adobe Server-to-Server licence required): share the ACCESS token here and
-- serialise the exchange with a DB lock. src/lib/frameio/auth.ts reads the shared
-- access token, and only the runtime that atomically claims `refreshing_until`
-- performs the exchange, persisting the rotated refresh token + new access token.
--
-- Additive + nullable: safe on the live singleton row, reversible.

alter table public.frameio_token_state
  add column if not exists access_token text,
  add column if not exists access_expires_at timestamptz,
  add column if not exists refreshing_until timestamptz;

comment on column public.frameio_token_state.access_token is
  'Shared short-lived Adobe IMS access token. All runtimes read this; only the lock holder refreshes.';
comment on column public.frameio_token_state.access_expires_at is
  'When access_token expires (UTC). Refreshed under the refreshing_until lock before this.';
comment on column public.frameio_token_state.refreshing_until is
  'Cross-runtime refresh lock. A runtime claims the right to exchange by setting this to now()+TTL via a conditional UPDATE; NULL/past means free.';
