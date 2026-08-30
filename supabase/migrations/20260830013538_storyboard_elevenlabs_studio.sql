alter table if exists public.storyboard_jobs
  add column if not exists elevenlabs_project_id text,
  add column if not exists elevenlabs_url text,
  add column if not exists elevenlabs_status text,
  add column if not exists elevenlabs_error text;

comment on column public.storyboard_jobs.elevenlabs_project_id is
  'ElevenLabs Studio project created from the storyboard voiceover.';
comment on column public.storyboard_jobs.elevenlabs_status is
  'pending, complete, skipped, or failed; independently retryable from Boords.';
