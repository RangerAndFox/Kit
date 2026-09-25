-- Distinguish a cron's last ATTEMPT from its last SUCCESS.
--
-- The health watchdog needs to tell "running but failing" (fresh attempt, stale
-- success) from "not running at all" (both stale). That requires a second
-- timestamp, and it requires a heartbeat row to be able to exist for a cron
-- that has attempted but never succeeded — so last_success_at becomes nullable
-- and loses its now() default (writers always set it explicitly on success;
-- an attempt-only write must NOT imply a success).
--
-- Backfill-safe: every existing row already has last_success_at set, so
-- dropping NOT NULL/default changes nothing for current data. Additive column
-- is nullable. Old code that only writes/reads last_success_at keeps working.

alter table public.cron_heartbeats
  add column if not exists last_attempt_at timestamptz;

alter table public.cron_heartbeats
  alter column last_success_at drop not null;

alter table public.cron_heartbeats
  alter column last_success_at drop default;

-- Actual runtime-owned configuration and persistent per-job enrollment. Cold
-- starts and repeated registration do not move the enrollment timestamp.
alter table public.cron_heartbeats
  add column owner_runtime text check (owner_runtime in ('railway','vercel')),
  add column enabled boolean,
  add column schedule jsonb,
  add column enrolled_at timestamptz;

create or replace function public.record_kit_cron(
  p_cron_id text, p_runtime text, p_enabled boolean, p_schedule jsonb, p_kind text
) returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_kind is null or p_runtime is null
    or p_kind not in ('register','attempt','success') or p_runtime not in ('railway','vercel')
    or p_enabled is null or p_schedule is null or nullif(p_cron_id,'') is null then
    raise exception 'invalid cron registration';
  end if;
  insert into public.cron_heartbeats(cron_id,owner_runtime,enabled,schedule,enrolled_at,last_attempt_at,last_success_at)
    values(p_cron_id,p_runtime,p_enabled,p_schedule,now(),
      case when p_kind in ('attempt','success') then now() end,
      case when p_kind='success' then now() end)
    on conflict(cron_id) do update set
      owner_runtime=excluded.owner_runtime,enabled=excluded.enabled,schedule=excluded.schedule,
      enrolled_at=case when public.cron_heartbeats.enabled=false and excluded.enabled=true then now()
        else coalesce(public.cron_heartbeats.enrolled_at,excluded.enrolled_at) end,
      last_attempt_at=greatest(excluded.last_attempt_at,public.cron_heartbeats.last_attempt_at),
      last_success_at=greatest(excluded.last_success_at,public.cron_heartbeats.last_success_at);
end;
$$;
revoke all on function public.record_kit_cron(text,text,boolean,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.record_kit_cron(text,text,boolean,jsonb,text) to service_role;
