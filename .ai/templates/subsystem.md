# Subsystem template

Copy this to document a subsystem. Keep it ≤ ~200 lines. Fill every section;
if something is unknown, write the fact and label it `Needs verification` —
do not leave blanks that read as "none." Use evidence labels (`Verified`,
`Production-verified`, `Needs verification`, `Decision required`).

---

# Subsystem: <name>

**Purpose** — What this subsystem is responsible for, in one or two sentences.

**Owner** — Human/team accountable, and the one canonical runtime owner of its
recurring work (invariant 6).

**Runtime** — Where it runs (Railway / Vercel / Supabase / studio worker) and
its trigger model (persistent, HTTP route, Inngest schedule, job claim, webhook).
Cross-reference `.ai/runtime.md`.

**Entry points** — The exact file(s) a session should open first to reach this
subsystem. Include the launch/registration point (e.g. `bolt/src/app.ts`, a
`route.ts` registration, a worker `src/`).

**Dependencies** — Internal (`src/lib/` modules, other subsystems) and external
(SaaS APIs). Note which are shared vs owned.

**Invariants** — The rules from `.ai/invariants.md` this subsystem must uphold,
plus any local to it. Be specific about idempotency, cursor ownership, and
retry-safety.

**Persistence** — Supabase tables/ledgers it reads or writes, cursors/dedupe
keys it owns, and the migration(s) that define them.

**External integrations** — APIs called, auth model (by reference to
`.ai/runtime.md` — never credentials), and rate/limit or rotation concerns.

**Tests** — What tests exist, where, and how to run them (command + working
dir). If none, say "none" — that is a finding.

**Validation** — The narrow → broad steps from `.ai/validation.md` that apply
to changes here.

**Failure modes** — How it breaks and how failures surface (a stuck cursor, a
consumed-but-unprocessed event, a duplicate notification). What is idempotent
vs not.

**Reading order** — The minimal ordered list of files to read to become
productive here (entry point first). This is the anti-context-bloat section —
keep it tight.

**Context budget** — Rough sense of how much to read for a typical change
(e.g. "entry point + one handler; do not read the whole directory").

**Open questions** — `Needs verification` / `Decision required` items.

**Evidence** — Which claims above are `Verified` in code vs reported, with the
file(s) that back them.
