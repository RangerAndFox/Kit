-- Onboarding is initiated by a server action after Supabase Auth verifies the
-- caller. Do not expose SECURITY DEFINER workspace creation to PostgREST users.

revoke execute on function public.check_slug_available(text) from authenticated;
revoke execute on function public.create_workspace(text, text, text, text) from authenticated;

create or replace function public.create_workspace_service(
  p_auth_user_id uuid,
  p_name text,
  p_slug text,
  p_user_name text,
  p_user_email text
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_workspace_id uuid;
  v_member_id uuid;
begin
  if p_auth_user_id is null then raise exception 'Authenticated user required'; end if;
  if length(trim(p_name)) < 2 or length(trim(p_name)) > 120 then raise exception 'Invalid workspace name'; end if;
  if p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then raise exception 'Invalid workspace slug'; end if;
  if length(trim(p_user_name)) < 1 or length(trim(p_user_name)) > 120 then raise exception 'Invalid member name'; end if;
  if length(trim(p_user_email)) < 3 or length(trim(p_user_email)) > 320 then raise exception 'Invalid member email'; end if;

  insert into public.workspaces (name, slug)
  values (trim(p_name), lower(trim(p_slug)))
  returning id into v_workspace_id;

  insert into public.team_members (
    workspace_id, auth_user_id, name, email,
    role, permission_tier, is_active, accepted_at
  ) values (
    v_workspace_id, p_auth_user_id, trim(p_user_name), lower(trim(p_user_email)),
    'admin', 'founder', true, now()
  ) returning id into v_member_id;

  insert into public.workspace_config (workspace_id, config_key, config_value) values
    (v_workspace_id, 'defaults', '{"margin_target": 0.40, "budget_alert_threshold": 0.75, "revision_rounds": 2}'::jsonb),
    (v_workspace_id, 'project_types', '["Animation", "VFX", "Motion Graphics", "Live Action", "Mixed Media"]'::jsonb);

  return json_build_object('workspace_id', v_workspace_id, 'member_id', v_member_id);
end;
$function$;

revoke all on function public.create_workspace_service(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_workspace_service(uuid, text, text, text, text) to service_role;
