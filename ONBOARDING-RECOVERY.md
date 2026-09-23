# Artist onboarding recovery

Producers and admins can ask Kit to add an existing artist to a project. Kit
resolves the Slack mention, opens an editable review card, and checks permission
again before granting access.

## Slack guests

- Kit never upgrades a guest to a full member or replaces their other channels.
- If Slack returns `user_is_restricted`, a workspace admin must open **Manage
  members → artist → Edit channels** and add only the requested project channel.
- A single-channel guest cannot join a second channel without an explicitly
  approved account-type decision. Do not silently upgrade them.
- For a new artist, invite them to the workspace **as a guest**. Slack Connect is
  a different membership model and is not an automatic fallback.
- Kit checks channel membership before inviting, and reconciles failed invite
  responses. A manually completed grant can therefore be recognized on retry.
- A welcome DM is sent only after the Slack step succeeds. Do not repeat the
  whole workflow solely to resend a welcome; reconcile recorded results first.

## Daily Assignments

- The canonical roster is `Lists!D5:D100` in the configured working workbook.
- Read timeouts and transient server errors receive bounded read-only retries.
- An uncertain roster write is read back from its exact cell. It is never
  blindly replayed. An unverified write remains a failure.
- Assignment validation is capped to the actual tab size (up to 1,000 rows).

## Optional setup

- Harvest requires an existing, dedicated shared freelancer user selected by
  `HARVEST_FREELANCER_USER_ID`. Onboarding does not create seats or log hours.
  Do not reuse a staff member's account or invent an ID to bypass setup.
- NDA sending requires `FREELANCER_PAPERWORK_ENABLED=true`, a verified
  `ONBOARDING_FROM_EMAIL`, and the Google service account's Gmail delegation.
  The operator still reviews the NDA and submits the send form. Disabled sending
  does not mean an NDA was signed or is on file.
- An unavailable paperwork ledger blocks another send instead of treating the
  artist as new.

## Partial completion

Preserve successful provider grants. Confirm live membership and the saved
onboarding/access ledgers before retrying. Tracking failures hold onboarding for
administrator reconciliation rather than reporting an unaudited success. A
technical timeout is not proof that the external operation did not happen.
