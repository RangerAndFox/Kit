-- 058_pilots.sql
-- Bounded, evidence-driven Pilots capability.
--
-- A "pilot" is a bounded, time-limited experiment attached to ONE existing Kit
-- project, whose purpose is to collect TRUSTWORTHY EVIDENCE and end in a
-- human-authored recommendation. The first (and currently only) pilot type is
-- 'visual_development' (AI-assisted visual development), but the schema is the
-- reusable capability — the visual-development workflow is one pilot_type, not a
-- new table family. Only concepts demonstrably shared across pilots are
-- generalized: pilot record, append-only evidence, generated outputs with human
-- acceptance, external references, validations, and the recommendation.
--
-- AUTHORITATIVE OWNER: Supabase. Any Slack Canvas is a deterministic, read-only
-- projection of these rows — Canvas prose is never authoritative state.
--
-- Integrity is enforced STRUCTURALLY wherever possible (not only in code or UI):
--   * project_id foreign key + workspace scoping;
--   * pilot_type / lifecycle-state / evidence-category / acceptance-state /
--     map-type / validation-tool / recommendation enums via named checks;
--   * at most one NON-TERMINAL pilot of the same type per project;
--   * exactly one designated Figma moodboard reference per pilot;
--   * every material map carries a non-empty production purpose;
--   * technical validation carries a non-empty recorded evidence reference;
--   * a finalized pilot must carry a recommendation + author;
--   * an accepted generation must carry the accepting human;
--   * append-only evidence has NO update path and outputs may only transition
--     their acceptance fields (enforced by triggers), never be rewritten/deleted.
--
-- Conventions mirror 055/056: lowercase DDL, create-if-not-exists, named check
-- constraints, unique identity keys, table comments, RLS on with no policies
-- (service-role only). No existing table is altered.

begin;

-- ─── 1. Pilot record ─────────────────────────────────────────────────────────
create table if not exists public.pilots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Nullable workspace scope for authorizing Slack actions (mirrors
  -- project_creation_requests.workspace_id).
  workspace_id uuid references public.workspaces(id) on delete cascade,
  -- The pilot type. Extensible, but exactly one value exists today.
  pilot_type text not null default 'visual_development'
    constraint pilots_pilot_type_check check (pilot_type in ('visual_development')),
  title text,
  -- Lifecycle. 'active' is the only non-terminal state; 'finalized' (a
  -- recommendation was recorded) and 'abandoned' are terminal.
  status text not null default 'active'
    constraint pilots_status_check check (status in ('active', 'finalized', 'abandoned')),
  -- The articulated visual-language definition (required, singular → first-class).
  visual_language text,
  -- The final HUMAN-authored recommendation. Never generated/selected by a model.
  recommendation text
    constraint pilots_recommendation_check
    check (recommendation is null or recommendation in ('adopt', 'revise', 'repeat', 'discontinue')),
  recommendation_rationale text,
  -- Slack user id of the authorized human who entered the recommendation.
  recommendation_by text,
  recommendation_at timestamptz,
  -- Dedicated read-only pilot Canvas identity (a projection, not a source).
  canvas_id text,
  canvas_url text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A finalized pilot MUST carry a recommendation and its author. This makes the
  -- "no final state without a human recommendation" rule structural, not advisory.
  constraint pilots_finalized_requires_recommendation
    check (status <> 'finalized' or (recommendation is not null and recommendation_by is not null)),
  -- One bound Canvas globally (a canvas cannot back two pilots).
  constraint pilots_canvas_unique unique (canvas_id)
);

-- At most ONE non-terminal pilot of the same type per project. A finished pilot
-- (finalized/abandoned) never blocks starting a fresh one; two live pilots of the
-- same type on one project is a defect.
create unique index if not exists pilots_one_active_per_project_type
  on public.pilots (project_id, pilot_type)
  where status = 'active';

create index if not exists pilots_project_idx on public.pilots (project_id);

comment on table public.pilots is
  'Bounded evidence-driven experiment attached to one project. Supabase is authoritative; any Slack Canvas is a read-only projection. At most one active pilot per (project, type). Finalization requires a human-authored recommendation.';

-- ─── 2. Append-only evidence ─────────────────────────────────────────────────
-- Strict semantic separation of evidence categories (never undifferentiated
-- prose). Objective measurements carry structured value/unit/timestamp/author +
-- optional bounded provenance; subjective judgments stay explicitly subjective.
create table if not exists public.pilot_evidence (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  category text not null
    constraint pilot_evidence_category_check
    check (category in ('measurement', 'observation', 'judgment', 'assumption', 'unknown', 'risk', 'decision')),
  -- Stable key for measurements the completeness gate requires (e.g. 'time',
  -- 'cost', 'output_count', 'cleanup', 'originality', 'editability',
  -- 'continuity', 'quality', 'reuse_willingness'). Null for free-form categories.
  metric_key text,
  label text,
  -- Structured objective value (measurements). Subjective/qualitative content
  -- goes in value_text so it can never masquerade as an objective measurement.
  value_numeric numeric,
  value_text text,
  unit text,
  -- When the measurement/observation actually happened (distinct from created_at).
  observed_at timestamptz,
  -- Bounded provenance / type-specific metadata only.
  provenance jsonb,
  -- Who recorded it (Slack user id or 'system'). Required — no anonymous evidence.
  author text not null,
  -- Measurement integrity (structural, not only in code):
  --   * a measurement must carry a metric_key;
  --   * a measurement must carry a structured value (a number, or non-empty text);
  --   * a NON-measurement row must not carry a metric_key (keeps categories clean).
  constraint pilot_evidence_measurement_metric_key
    check (category <> 'measurement' or metric_key is not null),
  constraint pilot_evidence_measurement_has_value
    check (
      category <> 'measurement'
      or value_numeric is not null
      or (value_text is not null and length(btrim(value_text)) > 0)
    ),
  constraint pilot_evidence_metric_key_scope
    check (category = 'measurement' or metric_key is null),
  created_at timestamptz not null default now()
);

create index if not exists pilot_evidence_pilot_idx
  on public.pilot_evidence (pilot_id, category);
create index if not exists pilot_evidence_metric_idx
  on public.pilot_evidence (pilot_id, metric_key) where metric_key is not null;

comment on table public.pilot_evidence is
  'Append-only pilot evidence. Categories are strictly separated (measurement/observation/judgment/assumption/unknown/risk/decision). Objective measurements carry structured value+unit+timestamp; subjective judgments stay in value_text. No update path (trigger-enforced).';

-- ─── 3. Generated outputs (human acceptance) ─────────────────────────────────
-- Every generated artifact (e.g. a Higgsfield output) as a reference/upload, plus
-- an EXPLICIT, ATTRIBUTED human acceptance decision. Nothing is accepted by
-- default. The row is otherwise immutable: only the acceptance fields may change.
create table if not exists public.pilot_generations (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  -- Generator/source (reference only; no live API integration).
  source text,
  -- What kind of output (e.g. 'styleframe', 'material', 'image').
  kind text,
  -- Link or uploaded-evidence reference to the actual output.
  external_ref text,
  label text,
  -- Human acceptance. 'pending' until an authorized human decides. An 'accepted'
  -- row MUST name the accepting human (structural — never accepted anonymously).
  acceptance text not null default 'pending'
    constraint pilot_generations_acceptance_check
    check (acceptance in ('pending', 'accepted', 'rejected')),
  accepted_by text,
  accepted_at timestamptz,
  notes text,
  provenance jsonb,
  author text not null,
  created_at timestamptz not null default now(),
  constraint pilot_generations_accepted_requires_actor
    check (acceptance <> 'accepted' or accepted_by is not null)
);

create index if not exists pilot_generations_pilot_idx
  on public.pilot_generations (pilot_id, acceptance);

comment on table public.pilot_generations is
  'Append-only generated outputs (reference/upload) with an explicit, attributed human acceptance decision. Default acceptance is pending; nothing is accepted by default. Only acceptance fields may be updated (trigger-enforced); rows are never deleted.';

-- ─── 4. External references ──────────────────────────────────────────────────
-- Pinterest research, the ONE designated Figma moodboard, and deliberately
-- distinct styleframe directions. External tools stay references, never
-- replicated data / API integrations.
create table if not exists public.pilot_references (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  ref_type text not null
    constraint pilot_references_ref_type_check
    check (ref_type in ('pinterest', 'figma_moodboard', 'styleframe_direction', 'other')),
  url text,
  label text,
  description text,
  provenance jsonb,
  author text not null,
  created_at timestamptz not null default now(),
  -- Pinterest research + the Figma moodboard are external links → require a
  -- non-empty (trimmed) URL. A styleframe_direction may be a described direction
  -- without a URL.
  constraint pilot_references_link_requires_url
    check (
      ref_type not in ('pinterest', 'figma_moodboard')
      or (url is not null and length(btrim(url)) > 0)
    )
);

-- EXACTLY ONE designated Figma moodboard per pilot.
create unique index if not exists pilot_references_one_figma_moodboard
  on public.pilot_references (pilot_id)
  where ref_type = 'figma_moodboard';

create index if not exists pilot_references_pilot_idx
  on public.pilot_references (pilot_id, ref_type);

comment on table public.pilot_references is
  'External references for a pilot (Pinterest research, the one designated Figma moodboard, deliberately distinct styleframe directions). Exactly one figma_moodboard per pilot. External tools remain references, not integrations.';

-- ─── 5. Material maps (type-specific shape) ──────────────────────────────────
-- The material package(s) and their maps. Distinct from generations because the
-- shape genuinely differs: each map has a map_type and a REQUIRED production
-- purpose. A "material package" is a distinct package_name grouping.
create table if not exists public.pilot_material_maps (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  -- Groups maps into a package (a "material package" = a distinct package_name).
  package_name text not null,
  map_type text not null
    constraint pilot_material_maps_map_type_check
    check (map_type in ('albedo', 'roughness', 'normal', 'height', 'displacement', 'metalness', 'ao', 'opacity', 'other')),
  -- Every map MUST state its production purpose (technically justified maps).
  purpose text not null
    constraint pilot_material_maps_purpose_nonempty check (length(btrim(purpose)) > 0),
  external_ref text,
  provenance jsonb,
  author text not null,
  created_at timestamptz not null default now()
);

create index if not exists pilot_material_maps_pilot_idx
  on public.pilot_material_maps (pilot_id, package_name);

comment on table public.pilot_material_maps is
  'Material-package maps for a pilot. A material package is a distinct package_name. Every map carries a map_type and a REQUIRED non-empty production purpose (structurally enforced).';

-- ─── 6. Technical validation (Cinema 4D / Redshift) ──────────────────────────
-- Technical validity requires RECORDED evidence — evidence_ref is NOT NULL and
-- non-empty, so nothing can be marked technically valid without it.
create table if not exists public.pilot_validations (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  tool text not null
    constraint pilot_validations_tool_check check (tool in ('cinema4d', 'redshift')),
  -- Recorded evidence reference (e.g. a render/screenshot upload or link). The
  -- guarantee behind "technically valid": there is always evidence to point to.
  evidence_ref text not null
    constraint pilot_validations_evidence_nonempty check (length(btrim(evidence_ref)) > 0),
  -- What was validated (free text or a reference to a generation/material).
  subject text,
  passed boolean not null default true,
  note text,
  provenance jsonb,
  author text not null,
  created_at timestamptz not null default now()
);

create index if not exists pilot_validations_pilot_idx
  on public.pilot_validations (pilot_id, tool);

comment on table public.pilot_validations is
  'Cinema 4D / Redshift technical validation records for a pilot. A non-empty recorded evidence_ref is required, so technical validity always has evidence behind it.';

-- ─── Append-only / immutability triggers ─────────────────────────────────────
-- Evidence is strictly append-only: block UPDATE and DELETE entirely.
create or replace function public.pilots_evidence_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'pilot_evidence is append-only (% not allowed)', tg_op;
end;
$$;

drop trigger if exists pilot_evidence_no_modify on public.pilot_evidence;
create trigger pilot_evidence_no_modify
  before update or delete on public.pilot_evidence
  for each row execute function public.pilots_evidence_immutable();

-- Generations are append-only EXCEPT the acceptance decision: block DELETE, and
-- on UPDATE reject any change to a non-acceptance column. The only mutable fields
-- are acceptance / accepted_by / accepted_at.
create or replace function public.pilots_generation_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pilot_generations rows cannot be deleted (append-only)';
  end if;
  if new.id is distinct from old.id
     or new.pilot_id is distinct from old.pilot_id
     or new.source is distinct from old.source
     or new.kind is distinct from old.kind
     or new.external_ref is distinct from old.external_ref
     or new.label is distinct from old.label
     or new.notes is distinct from old.notes
     or new.provenance is distinct from old.provenance
     or new.author is distinct from old.author
     or new.created_at is distinct from old.created_at then
    raise exception 'pilot_generations is immutable except acceptance fields';
  end if;
  return new;
end;
$$;

drop trigger if exists pilot_generations_guard on public.pilot_generations;
create trigger pilot_generations_guard
  before update or delete on public.pilot_generations
  for each row execute function public.pilots_generation_guard();

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Kit-internal operational tables written/read ONLY by the service role. Enable
-- RLS with NO policies so anon/authenticated clients get nothing; the
-- service-role key bypasses RLS. Mirrors 056_project_control.sql.
alter table public.pilots enable row level security;
alter table public.pilot_evidence enable row level security;
alter table public.pilot_generations enable row level security;
alter table public.pilot_references enable row level security;
alter table public.pilot_material_maps enable row level security;
alter table public.pilot_validations enable row level security;

commit;
