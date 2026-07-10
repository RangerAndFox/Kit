-- Project aliases: internal codenames/nicknames that resolve to a project.
-- The studio-knowledge lookup only matched project_code / name / client, so a
-- spoken codename like "Marshmallow Man" resolved to nothing even though the
-- team all knows which project it means. Aliases are stored lowercased and
-- matched exactly (case-insensitive) ahead of the fuzzy name search.

alter table public.projects
  add column if not exists aliases text[] not null default '{}'::text[];

comment on column public.projects.aliases is
  'Lowercased internal codenames/nicknames that resolve to this project (e.g. {"marshmallow man"}).';

-- GIN index so array-containment lookups stay fast as the project list grows.
create index if not exists idx_projects_aliases on public.projects using gin (aliases);
