-- One transaction/request instead of a burst of per-cron registration RPCs.
-- Registration must never manufacture a successful job outcome.
create function public.register_kit_crons(p_runtime text,p_crons jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb;
begin
  if p_runtime not in ('railway','vercel') or p_runtime is null or jsonb_typeof(p_crons) is distinct from 'array'
    or jsonb_array_length(p_crons)>50 then raise exception 'Invalid cron registration batch'; end if;
  for item in select value from jsonb_array_elements(p_crons) loop
    perform public.record_kit_cron(item->>'id',p_runtime,(item->>'enabled')::boolean,item->'schedule','register');
  end loop;
end; $$;
revoke all on function public.register_kit_crons(text,jsonb) from public,anon,authenticated;
grant execute on function public.register_kit_crons(text,jsonb) to service_role;
