-- Recovery may join consecutive messages. Own EVERY constituent event in
-- the same transaction as the row claim, or roll back without parsing any.
create function public.claim_checkin_reply(p_checkin_id uuid, p_reply_timestamps text[])
returns boolean language plpgsql security invoker set search_path = public as $$
declare c public.daily_hours_checkins; reply text; owner_id uuid;
begin
  if coalesce(cardinality(p_reply_timestamps), 0) < 1 or cardinality(p_reply_timestamps) > 100
    or exists (select 1 from unnest(p_reply_timestamps) t where t is null or t !~ '^[0-9]+\.[0-9]+$') then
    raise exception 'invalid check-in reply timestamps';
  end if;
  update public.daily_hours_checkins set status = 'replied', reply_ts = p_reply_timestamps[1], updated_at = now()
  where id = p_checkin_id and status in ('sent', 'nudged') returning * into c;
  if not found then return false; end if;
  -- The row trigger has already claimed the first event. Sorting remaining
  -- keys keeps competing overlapping bursts from taking opposite lock orders.
  for reply in select distinct t from unnest(p_reply_timestamps) t order by t loop
    insert into public.checkin_reply_claims(staff_id, channel_id, reply_ts, checkin_id)
    values(c.staff_id, c.dm_channel_id, reply, c.id)
    on conflict (staff_id, channel_id, reply_ts) do nothing;
    select checkin_id into owner_id from public.checkin_reply_claims
    where staff_id=c.staff_id and channel_id=c.dm_channel_id and reply_ts=reply;
    if owner_id is distinct from c.id then
      raise exception 'checkin_reply_already_owned' using errcode = '23505';
    end if;
  end loop;
  return true;
end $$;
revoke all on function public.claim_checkin_reply(uuid, text[]) from public, anon, authenticated;
grant execute on function public.claim_checkin_reply(uuid, text[]) to service_role;
