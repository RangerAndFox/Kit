-- Celebration memes: birthdays (recurring by MM-DD on staff) + scheduled and
-- delivery occasions Kit posts to the full-team channel.

alter table staff add column if not exists birthday text; -- 'MM-DD'

create table if not exists celebrations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,          -- 'scheduled' | 'delivery' | 'holiday'
  label       text not null,          -- occasion text / project name / holiday date
  fire_date   date not null,          -- the day to celebrate
  created_by  text,                   -- slack user id (scheduled) or null
  posted_at   timestamptz,            -- set when the meme posts (one-shot / dedup)
  created_at  timestamptz not null default now()
);

-- One meme per (kind, label, day): dedups a burst of delivery files and keeps
-- a scheduled/holiday occasion from firing twice.
create unique index if not exists celebrations_kind_label_date
  on celebrations (kind, label, fire_date);

alter table celebrations enable row level security;
