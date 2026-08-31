-- 016_rls_token_tables.sql
-- Enable RLS on OAuth token tables flagged by Supabase's security advisor.
--
-- dropbox_state and frameio_token_state hold rotating refresh tokens. They
-- are accessed only via the service-role key in Kit's backend (see
-- src/lib/frameio/auth.ts and src/lib/dropbox/client.ts), and the service
-- role bypasses RLS automatically.
--
-- Enabling RLS WITHOUT adding policies has the effect of locking anon and
-- authenticated keys out of these tables entirely — which is exactly the
-- desired posture for tables holding secrets. No policies are added by
-- design: any future client-side access would have to be explicit.

begin;

alter table public.dropbox_state enable row level security;
alter table public.frameio_token_state enable row level security;

commit;
