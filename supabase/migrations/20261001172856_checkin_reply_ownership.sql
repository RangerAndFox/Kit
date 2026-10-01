-- Persist event ownership even after Redo replaces the row's reply cursor.
-- The primary key serializes live/recovery/adhoc writers across processes.
lock table public.daily_hours_checkins in share row exclusive mode;
create table public.checkin_reply_claims (
  staff_id uuid not null references public.staff(id),
  channel_id text not null,
  reply_ts text not null,
  checkin_id uuid not null references public.daily_hours_checkins(id),
  claimed_at timestamptz not null default now(),
  primary key (staff_id, channel_id, reply_ts)
);
create index checkin_reply_claims_checkin_idx on public.checkin_reply_claims(checkin_id);
alter table public.checkin_reply_claims enable row level security;
revoke all on public.checkin_reply_claims from public, anon, authenticated;
grant select, insert on public.checkin_reply_claims to service_role;

-- Preserve historical rows. Prefer a successful receipt over a stale copy;
-- ties are deterministic. This does NOT mark any time as logged.
insert into public.checkin_reply_claims (staff_id, channel_id, reply_ts, checkin_id)
select distinct on (staff_id, dm_channel_id, reply_ts)
  staff_id, dm_channel_id, reply_ts, id
from public.daily_hours_checkins
where dm_channel_id is not null and reply_ts is not null
order by staff_id, dm_channel_id, reply_ts,
  (status = 'logged') desc, updated_at asc, id;

create function public.enforce_checkin_reply_ownership() returns trigger
language plpgsql security invoker set search_path = public as $$
declare owner_id uuid; inserted_id uuid;
begin
  if new.reply_ts is null or new.dm_channel_id is null then return new; end if;
  -- Closing an invalid card is allowed; claiming, parsing or logging it is not.
  if new.status not in ('replied', 'parsed', 'logging') then return new; end if;
  insert into public.checkin_reply_claims(staff_id, channel_id, reply_ts, checkin_id)
  values(new.staff_id, new.dm_channel_id, new.reply_ts, new.id)
  on conflict (staff_id, channel_id, reply_ts) do nothing
  returning checkin_id into inserted_id;
  select checkin_id into owner_id from public.checkin_reply_claims
    where staff_id = new.staff_id and channel_id = new.dm_channel_id and reply_ts = new.reply_ts;
  if owner_id is distinct from new.id or (new.status = 'replied' and inserted_id is null) then
    raise exception 'checkin_reply_already_owned' using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function public.enforce_checkin_reply_ownership() from public, anon, authenticated;
grant execute on function public.enforce_checkin_reply_ownership() to service_role;
create trigger checkin_reply_ownership
after insert or update of reply_ts, status, dm_channel_id, staff_id on public.daily_hours_checkins
for each row execute function public.enforce_checkin_reply_ownership();

-- Recheck status and ownership before reminding/confirming. Missing claims
-- fail closed. Other hours on the same day may be legitimate additional work.
create function public.checkin_action_is_current(p_checkin_id uuid, p_expected_status text)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from public.daily_hours_checkins c
    where c.id = p_checkin_id and c.status = p_expected_status
      and (c.status in ('sent', 'nudged') or exists (
        select 1 from public.checkin_reply_claims r
        where r.staff_id = c.staff_id and r.channel_id = c.dm_channel_id
          and r.reply_ts = c.reply_ts and r.checkin_id = c.id
      ))
  );
$$;
revoke all on function public.checkin_action_is_current(uuid, text) from public, anon, authenticated;
grant execute on function public.checkin_action_is_current(uuid, text) to service_role;
