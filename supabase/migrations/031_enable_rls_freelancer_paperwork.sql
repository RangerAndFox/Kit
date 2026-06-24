-- Close a security gap: freelancer_paperwork shipped (migration 029) with RLS
-- disabled, leaving it fully readable/writable by the anon and authenticated
-- roles — anyone with the anon key could read or modify every freelancer's
-- NDA/paperwork status.
--
-- Kit only ever touches this table through the service-role client
-- (createAdminClient, src/lib/supabase/admin.ts), which bypasses RLS, so
-- enabling RLS with no policies locks out anon/authenticated access without
-- affecting any code path. This matches every other table in the schema.
ALTER TABLE public.freelancer_paperwork ENABLE ROW LEVEL SECURITY;
