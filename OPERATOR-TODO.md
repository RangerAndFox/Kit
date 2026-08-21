# Kit — Operator follow-ups

Current as of 2026-08-21. This list contains only checks that require live provider access, a future event, a studio machine, or an operator decision. Completed engineering work belongs in `SESSION-HANDOFF.md`, not here.

## Immediate production verification

### 1. Confirm Railway deployed current `main`

GitHub/Vercel checks pass on merged pull requests, but the Railway connector entered a repeated authentication loop during the August 21 audit. In Railway, confirm the Bolt service's latest deployment commit matches GitHub `main`, uses the Kit repository, and is healthy at `/health`.

Why this matters: the Slack bot, outgoing-file Dropbox webhook, Frame.io mirror, hours prompts, and recovery sweeps run on Railway—not Vercel.

### 2. Verify the next Dropbox → Frame.io review share

The V4 share endpoint was repaired in PR #138. On the next real file placed under:

```text
/production/<year>/<project>/09_Outgoing/01_Client Progress/...
```

or:

```text
/production/<year>/<project>/09_Outgoing/02_Delivery/...
```

confirm all three outcomes:

1. The file appears in the matching Frame.io `03_Outgoing` folder.
2. The Slack notification's “Open review on Frame.io” link opens a public asset share, not only the logged-in file view.
3. Railway logs contain `share link created`, not `share create failed`.

### 3. Confirm project 2633 Frame.io auto-backfill

Supabase currently has project `2633-Microsoft / Biz Apps` linked to Slack, Dropbox, and Harvest, but not Frame.io. Its next eligible outgoing-file event should discover the Frame.io project by project number and persist `external_links.frameio_id`. After that event, reopen `/kit update` and verify the project remains editable and the Frame.io link is present.

Do not create a second Frame.io project or manually guess an ID. If discovery fails, inspect the live Frame.io project's name and Railway logs first.

### 4. Observe the next daily-hours occurrence

The reminder delivery ledger/index is merged and the two historical Allyson over-log incidents are already remediated. On the next workday after 5pm in the recipient's local Slack timezone, verify:

- the prompt appears once in the recipient's private one-person Kit channel;
- a reply produces the confirmation card;
- confirming writes the intended Harvest entries once;
- a missed 5pm tick catches up within the configured window rather than disappearing.

### 5. Observe the next meeting briefing

For the next qualifying calendar event, verify the private briefing uses exactly the simplified structure:

- Meeting info
- Attendee info — external attendees only, with sourced background when available
- Positioning — one natural-language paragraph about Ranger & Fox's fit

Use a bizdev meeting, kickoff, or active-project meeting. Confirm internal R&F attendees do not appear in Attendee info and the briefing is delivered only to matched R&F invitees unless channel posting was deliberately enabled.

## Studio infrastructure

### Delivery workers

The `/Delivery-Queue/` pipeline is distinct from the project outgoing-file mirror. Use `/kit workers` to confirm at least one studio render worker is online before relying on profile-based transcodes. If no worker is registered, follow `kit-render-worker/README.md` on the intended studio machine and run an end-to-end short-file test.

### After Effects / Deadline

Use `AE-RENDER-FARM-HANDOFF.md` for the first production render verification. Confirm Deadline status parsing, After Effects output-module behavior, terminal Slack notification, and any delivery-spec transcode handoff separately.

## Decisions still requiring an owner

- Decide whether `creative_director` should retain artist-tier visibility or map to producer-tier visibility.
- Decide whether meeting briefings should ever post to project channels; private attendee delivery is the safe default.
- Decide whether nightly studio-knowledge auto-summarization should be enabled after enough real notes/transcripts accumulate.

## Recurring checks

- After every merge affecting `bolt/`, confirm Railway deployed the merge commit and `/health` is green.
- After every merge affecting Inngest functions, confirm the production function sync and that Preview deployments registered zero functions.
- Review `/status` and the daily health digest for Dropbox, Frame.io, Harvest, Supabase, Google, and cron freshness.
- Run `npm audit` in both the repository root and `bolt/` during dependency maintenance.
- Reconcile Harvest projects/contacts into Kit on the studio's chosen cadence; keep the operation idempotent and preview changes before applying.
