-- Waiting on an asynchronous provider is not a failed attempt. Release the
-- fenced inbox claim and schedule another poll without consuming the event's
-- finite error budget.
create or replace function public.defer_dropbox_event(
  p_event_id uuid,
  p_claim_token uuid,
  p_reason text,
  p_delay_seconds integer default 300
)
returns boolean
language plpgsql
set search_path to 'public'
as $function$
begin
  update public.dropbox_event_inbox
    set status = 'retryable',
        attempt_count = greatest(attempt_count - 1, 0),
        next_attempt_at = now() + make_interval(
          secs => least(greatest(coalesce(p_delay_seconds, 300), 30), 3600)
        ),
        claim_token = null,
        claimed_by = null,
        claimed_at = null,
        last_error = left(coalesce(p_reason, 'waiting on provider'), 4000),
        updated_at = now()
    where id = p_event_id
      and status = 'processing'
      and claim_token = p_claim_token;
  return found;
end;
$function$;

revoke all on function public.defer_dropbox_event(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.defer_dropbox_event(uuid, uuid, text, integer)
  to service_role;
