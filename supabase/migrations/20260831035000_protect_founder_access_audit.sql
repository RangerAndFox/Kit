-- Founder-content access is an immutable audit trail. Signed-in users may
-- inspect rows allowed by RLS, but only trusted service code may append them.

drop policy if exists "System logs access" on public.founder_content_access;

revoke all on table public.founder_content_access from public, anon, authenticated, service_role;
grant select on table public.founder_content_access to authenticated;
grant select, insert on table public.founder_content_access to service_role;
