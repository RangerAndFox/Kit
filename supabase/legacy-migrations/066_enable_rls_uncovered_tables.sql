-- Close legacy service-owned tables that were created without RLS.
--
-- Kit reaches these tables through the server-side service-role client. No
-- browser/client policies are intentionally added here: enabling RLS with no
-- policies makes anon/authenticated access fail closed while preserving the
-- existing service-role workflows.

begin;

alter table if exists public.brains enable row level security;
alter table if exists public.brain_revisions enable row level security;
alter table if exists public.meeting_briefings enable row level security;
alter table if exists public.meeting_briefing_deliveries enable row level security;
alter table if exists public.review_extractions enable row level security;
alter table if exists public.shot_lists enable row level security;
alter table if exists public.storyboard_jobs enable row level security;
alter table if exists public.daily_hours_reminders enable row level security;

commit;
