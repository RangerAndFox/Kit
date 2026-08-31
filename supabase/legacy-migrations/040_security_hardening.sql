-- Security hardening (full-audit follow-up).
--
-- Findings from Supabase's security advisors:
--   1. match_documents — the semantic search over the ENTIRE studio knowledge
--      base (briefs, budgets in notes, transcripts, brain sections) — was
--      executable by the public `anon` role via /rest/v1/rpc. Kit only ever
--      calls it through the service-role client. Lock it to service_role.
--   2. The workspace-helper RPCs (create_workspace, check_slug_available,
--      get_user_tier, get_user_workspace_ids, is_founder,
--      is_founder_or_producer) were executable by `anon`. They're used by
--      authenticated server actions and RLS policies — `authenticated` keeps
--      EXECUTE, `anon` loses it (create_workspace already requires a session
--      in the app layer; this closes the direct-REST path).
--   3. Eight SECURITY DEFINER functions had a role-mutable search_path —
--      pin them to public so a crafted search_path can't hijack references.
--   4. managed_agent_registry had an always-true RLS policy ("service role
--      full access" FOR ALL USING true) — service_role BYPASSES RLS, so the
--      policy's only effect was granting anon/authenticated full access.
--      Drop it; RLS-on/no-policies = service-role only, matching every other
--      Kit table.

-- 1. match_documents → service_role only
REVOKE EXECUTE ON FUNCTION public.match_documents(vector, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents(vector, integer, uuid, uuid) TO service_role;

-- 2. Workspace helpers → authenticated + service_role (drop anon/PUBLIC)
REVOKE EXECUTE ON FUNCTION public.create_workspace(text, text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.check_slug_available(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_tier(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_workspace_ids() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_founder(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_founder_or_producer(uuid) FROM PUBLIC, anon;

-- 3. Pin search_path on SECURITY DEFINER / trigger functions
ALTER FUNCTION public.match_documents(vector, integer, uuid, uuid) SET search_path = public;
ALTER FUNCTION public.create_workspace(text, text, text, text) SET search_path = public;
ALTER FUNCTION public.check_slug_available(text) SET search_path = public;
ALTER FUNCTION public.get_user_tier(uuid) SET search_path = public;
ALTER FUNCTION public.get_user_workspace_ids() SET search_path = public;
ALTER FUNCTION public.is_founder(uuid) SET search_path = public;
ALTER FUNCTION public.is_founder_or_producer(uuid) SET search_path = public;
ALTER FUNCTION public.update_updated_at() SET search_path = public;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public;

-- 4. managed_agent_registry: drop the always-true policy (service-role only)
DROP POLICY IF EXISTS "service role full access" ON public.managed_agent_registry;
