-- No lease expiry: an ambiguous billing write may have committed remotely.
-- Only a verified Harvest receipt or a definitive rejection can resolve it.
create table public.harvest_time_intents (
  account_id text not null,
  intent_key text not null check (length(intent_key) between 1 and 200),
  owner uuid not null,
  state text not null check (state in ('posting','committed','rejected')),
  harvest_entry_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(account_id,intent_key),
  check ((state = 'committed') = (harvest_entry_id is not null))
);
alter table public.harvest_time_intents enable row level security;
revoke all on public.harvest_time_intents from public, anon, authenticated;
grant select, insert, update on public.harvest_time_intents to service_role;

create function public.record_harvest_time_intent(p_account text, p_key text, p_owner uuid, p_action text, p_entry_id bigint default null)
returns boolean language plpgsql security invoker set search_path = public as $$
declare changed integer;
begin
  if nullif(trim(p_account),'') is null or p_owner is null then raise exception 'Account and owner required'; end if;
  if p_action = 'claim' then
    insert into public.harvest_time_intents(account_id,intent_key,owner,state)
      values(p_account,p_key,p_owner,'posting') on conflict do nothing;
    get diagnostics changed = row_count;
    if changed = 1 then return true; end if;
    update public.harvest_time_intents set owner=p_owner,state='posting',updated_at=now()
      where account_id=p_account and intent_key=p_key and state='rejected';
    get diagnostics changed = row_count;
    return changed = 1;
  elsif p_action in ('commit','reconcile') then
    if p_entry_id is null or p_entry_id <= 0 then raise exception 'Verified Harvest entry required'; end if;
    if p_action = 'reconcile' then
      insert into public.harvest_time_intents(account_id,intent_key,owner,state,harvest_entry_id)
        values(p_account,p_key,p_owner,'committed',p_entry_id) on conflict do nothing;
    end if;
    update public.harvest_time_intents set state='committed',harvest_entry_id=p_entry_id,updated_at=now()
      where account_id=p_account and intent_key=p_key
        and (p_action='reconcile' or owner=p_owner)
        and (harvest_entry_id is null or harvest_entry_id=p_entry_id);
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'Harvest intent receipt conflict'; end if;
    return true;
  elsif p_action = 'reject' then
    update public.harvest_time_intents set state='rejected',updated_at=now()
      where account_id=p_account and intent_key=p_key and owner=p_owner and state='posting';
    get diagnostics changed = row_count;
    return changed = 1;
  end if;
  raise exception 'Unknown Harvest intent action';
end;
$$;
revoke all on function public.record_harvest_time_intent(text,text,uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.record_harvest_time_intent(text,text,uuid,text,bigint) to service_role;
