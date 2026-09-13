# Function guidance — repository verification

## Behavior

All 24 command families have maintained step-by-step guidance. Asking how a feature works is read-only. Eligible users see Start privately / Not now, or a request for missing identifiers when a workflow cannot start without them. Starting opens the existing private review, not the operation itself.

Same-user, same-team, same-channel, same-thread affirmative replies can open a review within the existing 15-minute conversation-memory window. The memory stores only a non-sensitive command key or clarification marker. The current actor is authorized again before offering a command review; persisted, single-use command requests remain the execution boundary.

Expired/lost guidance context and unreadable/truncated threads fail closed for short confirmations. An answer to a function-selection clarification remains instruction-only. Public guidance contains only static product instructions, not project values or private contact data.

## Checks

- 808 Bolt tests passed across 66 files, including guidance coverage for every catalog command, natural wording, role restrictions, semantic fallback, invalid model calls, sibling-write suppression, callback identity, follow-up expiry/isolation, provider-read failure and pending-onboarding/hours interception regressions.
- Root, Bolt and tools TypeScript checks passed.
- ESLint ratchet passed with no new debt (existing baseline debt remains).
- Production read-only schema check confirmed conversation_state.state is JSONB with RLS enabled. No schema migration or permission change is required.
- Existing untracked team launch guide was left untouched.

## Release boundary

This is a new change after PR #175. The prior independent-review override was for that release only. Do not infer approval to bypass review again. Production rollout and live guide/button verification are separate from repository validation and must be confirmed after a reviewed or explicitly authorized release.

Safe production acceptance: privately ask how to onboard an artist, verify the steps without any provider work, reply yes in that thread and verify a private review card, then cancel without submitting onboarding. Also check an expired-guide reply cannot confirm a Harvest entry. Do not invite a real artist merely to test routing.
