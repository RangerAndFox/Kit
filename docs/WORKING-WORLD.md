# Ranger & Fox Working World

`/working-world` is an admin/founder-only, read-only operations city. It uses the
same server-verified access boundary as Control Center, including inactive-member
denial. `/api/working-world` never accepts a workspace or acting identity from a
caller. No migration, new credential, cron, Inngest function or AI call is needed.

## First release

- Isometric city geometry with eight 45° views, bounded zoom, pointer pan, wheel
  zoom and two-pointer pinch; camera preferences stay in versioned local storage.
- Ranger & Fox signage, studio colors and decorative foxes. Foxes never represent
  jobs. Animation can be paused independently of records and honors reduced motion.
- Recorded Kit runs, project control, storyboard, upload, onboarding, hours,
  archive, Behance and ElevenLabs jobs. Roles/workflows are not falsely presented
  as independent running processes. Dormant managed-agent definitions stay dormant.
- Marketing and engineering are visibly **not connected**. They are placeholders
  for future authorized organizational-agent feeds, not simulated live agents.
- Activity updates every 10 seconds while visible. Requests never overlap; errors
  back off to 30 seconds, and source data becomes last-known/unknown. This is live
  record polling, not an assertion of zero-latency provider event streaming.
- Data uses explicit columns, 25-row per-source bounds (plus a truncation sentinel),
  scoped workspace/project/member queries, and isolated source failures. Provider
  URLs, credentials, prompts, rates and serialized payloads are not sent to the city.
  Single-studio health rows are withheld after a second workspace is introduced.
- Waiting approvals/queues are amber, explicit failures are blocked, and missing
  or stale evidence is unknown. Quiet data does not prove a process is healthy.
- The diagnostics panel is deterministic, evidence-backed record lookup, **not**
  general-purpose AI chat. It cannot retry, publish, invite or mutate anything.
  Links open the actual recorded Slack request or project. It never invents a GPT,
  Codex or provider session URL; absent session links are explicitly unavailable.

## Adding organizational feeds later

Implement a server-side, allowlisted source adapter and register its catalog role.
Bind workspace and actor to authenticated identity, query bounded source records,
and expose stable task IDs, recorded states, timestamps and only verified deep
links. Add tests for denial, scoping, stale evidence, failure isolation and URL
validation. Do not scrape browser sessions or place privileged credentials in
the client. A source without job/session telemetry must remain unconnected.

Project-specific cities and operational write actions are intentionally deferred.

## Verification / rollout

Run the Working World model, scope, HTTP and camera tests; all app tests; all
three typechecks; the lint ratchet; and the production build. Browser-test camera,
selection, reduced motion, diagnostics, offline recovery and mobile layout in an
isolated fixture (never a public production fixture route). Merge only after the
existing required CI checks pass. Verify production revision and unauthenticated
API denial; the owner should open the signed-in page for the final private view.
Rollback is a code revert; no database or provider history needs undoing.
