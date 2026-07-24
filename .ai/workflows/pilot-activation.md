# Runbook: Visual Development Pilot activation

Operational runbook for enabling the Pilots capability and running the first
real pilot. The capability is merged and migration 058 is applied to production;
this covers the **live activation** an operator performs. Keep
`VISUAL_DEV_PILOT_ENABLED=false` until deploy + disabled smoke pass.

Owners: **Railway admin** (deploy + gate), **Slack operator** (`/kit` commands),
**Mission Control** (project + people), **artist** (creative work + validation),
**recommendation owner** (final call). Kit code cannot perform these — this is a
human/platform procedure. Repository-owned commands make each step checkable.

## Preconditions (verify, don't assume)

- Merged commit `550ae1de85cf03d788cdeb453db35d87f26c30af` (or descendant) on `main`.
- Supabase `ozsxrcgrezpffnpwlrnq`: migration `058_pilots` applied; six pilot
  tables present; **zero pilot rows**; no pilot Canvas.
- Railway Bolt service identity confirmed: repo `steve-rangerandfox/Kit`, branch
  `main`, deployed commit ≥ the merge commit, `VISUAL_DEV_PILOT_ENABLED` absent/false.
- Slack workspace **Ranger & Fox** (`team T4ATY2XAL`, Kit workspace row
  `ea0acf8c-89bd-425c-a979-05fffe84c28e`).
- Approved project, its Slack channel (Kit bot present), artist, recommendation owner.

Most of the runtime/DB/project checks are machine-verifiable — run
`/kit pilot readiness <projectId>` (see below) instead of manual SQL/log reads.

## 1. Deploy current `main` (gate stays false)

Railway admin: deploy `main` (≥ merge commit) via the normal Git integration.
Change no env vars; keep `VISUAL_DEV_PILOT_ENABLED` absent/false. Verify: deploy
succeeded, `/health` reports real Slack connectivity, Socket Mode connected, no
new startup errors, existing `/kit` commands still register.

## 2. Disabled smoke test

Slack operator runs: `/kit pilot help`
Expected (ephemeral): `🔒 The Visual Development Pilot capability is not enabled (VISUAL_DEV_PILOT_ENABLED).`
Checks: no command list; no error; runtime logs show the request handled;
pilot tables still **zero rows**; no Canvas. If anything else appears, STOP.

## 3. Enablement (separate, explicit)

Railway admin: set `VISUAL_DEV_PILOT_ENABLED=true` on the **Bolt service only**;
change nothing else. Railway restarts/redeploys the same commit. After restart:
- `/kit pilot help` → the command list appears.
- Pilot tables still **zero rows** (enablement alone creates nothing).
- Existing `/kit` commands still work; no new runtime errors.

## 4. Readiness + first pilot

Operator (in the pilot channel):
1. `/kit pilot readiness <projectId>` — confirm runtime ✅, schema ✅, project
   eligibility ✅ (exists, workspace match, no active collision, has channel),
   and note the 📝 human-required inputs.
2. `/kit pilot create <projectId> :: <title>` — capture the pilot id.
   Verify: exactly one pilot row; correct project/workspace; `created_by` = the
   operator; a second `create` for the same project is rejected
   (`active_pilot_exists`).

## 5. Execution (all evidence recorded through the command path)

Artist performs the real creative work; the operator records it. External tools
stay references/uploads (no API integrations). Commands:
- `ref <pilotId> pinterest <url> :: <note>` (≥1) · `ref <pilotId> figma <url> :: <label>` (exactly one)
- `visual-language <pilotId> :: <definition>`
- `ref <pilotId> styleframe - :: <direction>` (≥1)
- `generation <pilotId> <externalRef> :: <label>` then `accept|reject <generationId>` (≥1 accepted)
- `map <pilotId> <package> <albedo|roughness|normal|height|…> :: <purpose>` (purpose required)
- `validate <pilotId> cinema4d pass <evidenceRef> :: <subject>` and `… redshift pass …` (both must PASS)
- Measurements (`evidence <pilotId> measurement <key> :: <label> :: <value> [unit]`),
  required keys: **time, cost, output_count, cleanup, originality, editability,
  continuity, quality, reuse_willingness** (unit required for `time`, `cost`).
- `evidence <pilotId> assumption|unknown|decision :: <label> :: <text>` (record explicitly, "none identified" is valid).
- Inspect anytime: `/kit pilot check <pilotId>` (why finalization is blocked) and
  `/kit pilot status <pilotId>` (counts, usable-output rate, completeness).
- `/kit pilot show <pilotId>` refreshes the read-only Canvas (edits in place; a
  failure is safe to retry and never corrupts pilot data).

## 6. Finalization (human recommendation)

Recommendation owner decides. Operator runs:
`/kit pilot finalize <pilotId> <adopt|revise|repeat|discontinue> :: <rationale>`
Blocked until the deterministic completeness gate passes (`check` lists what's
missing). On success the Canvas is refreshed with the recommendation.

## Rollback (routine)

Disable the gate: set `VISUAL_DEV_PILOT_ENABLED=false` (or remove) on the Bolt
service; restart; `/kit pilot help` returns the disabled notice. Recorded pilot
data (append-only) is preserved. **Never** drop tables as routine rollback —
schema removal is a separate approved migration.

## Evidence capture template (fill in during activation)

```
Deploy:        commit=____ status=____ health=____ socket_mode=____
Disabled smoke: time=____ user=____ channel=____ response=____ rows=0 canvas=0
Enable:        set VISUAL_DEV_PILOT_ENABLED=true on Railway Bolt @ ____ (UTC)
Enabled smoke: help_ok=____ rows=0 canvas=0 errors=____
Pilot:         project=____ projectId=____ pilotId=____ channel=____ canvasId=____
People:        artist=____ recommendation_owner=____ operator=____
Finalize:      recommendation=____ by=____ at=____
```

Do not record secrets, credentials, or fabricated IDs.
