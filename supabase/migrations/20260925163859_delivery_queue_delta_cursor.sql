create table public.delivery_queue_scan_state (
  id boolean primary key default true check(id), cursor text,
  owner uuid, lease_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.delivery_queue_scan_state enable row level security;
revoke all on public.delivery_queue_scan_state from public, anon, authenticated;
grant select,insert,update on public.delivery_queue_scan_state to service_role;
insert into public.delivery_queue_scan_state(id) values(true);
alter table public.seen_dropbox_files add column delivery_queue_checked_at timestamptz;
alter table public.seen_dropbox_files add column delivery_queue_missing boolean not null default false;
create index seen_delivery_queue_pending on public.seen_dropbox_files(delivery_queue_checked_at nulls first)
  where notified_at is null and not delivery_queue_missing and lower(path) like '/delivery-queue/%';

create function public.delivery_queue_cursor(p_owner uuid,p_action text,p_cursor text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare row_state public.delivery_queue_scan_state; changed integer;
begin
  if p_owner is null then raise exception 'Owner required'; end if;
  if p_action='claim' then
    update public.delivery_queue_scan_state set owner=p_owner,lease_until=now()+interval '5 minutes',updated_at=now()
      where id and (lease_until is null or lease_until<now()) returning * into row_state;
    if not found then return jsonb_build_object('claimed',false); end if;
    return jsonb_build_object('claimed',true,'cursor',row_state.cursor);
  elsif p_action='checkpoint' then
    update public.delivery_queue_scan_state set cursor=p_cursor,updated_at=now(),lease_until=now()+interval '5 minutes'
      where id and owner=p_owner and lease_until>now();
  elsif p_action='release' then
    update public.delivery_queue_scan_state set owner=null,lease_until=null,updated_at=now()
      where id and owner=p_owner and lease_until>now();
  else raise exception 'Unknown cursor operation'; end if;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Delivery cursor ownership lost'; end if;
  return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.delivery_queue_cursor(uuid,text,text) from public,anon,authenticated;
grant execute on function public.delivery_queue_cursor(uuid,text,text) to service_role;
