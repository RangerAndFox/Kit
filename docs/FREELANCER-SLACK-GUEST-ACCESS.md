# Freelancer Slack access

Freelancers join Ranger & Fox as guests, not full workspace members or Slack
Connect participants. Kit never creates a regular-member invitation as fallback.

## New artist

1. Start Kit onboarding with the artist's email and project.
2. The Slack result requests an admin action. In Slack member management, invite
   the artist as a **single-channel guest**, selecting the named project channel.
3. After acceptance, rerun Kit onboarding. Kit verifies the local workspace,
   active guest role, and project membership before reporting Slack success or
   sending its private welcome message. Other service results remain separate.

## Additional project

An existing multi-channel guest can be added to the selected project channel.
Kit does not change roles. An admin must convert a single-channel guest to a
multi-channel guest and assign the appropriate project channels when needed;
Kit will not silently replace their existing channel or broaden workspace access.

## Verification failures

A regular member, external workspace user, pending invitation, inactive account,
missing role information, API failure, or unverified membership is not success.
Kit returns an actionable failed Slack result for admin review. It does not
deactivate the person or modify their other project access.

## Platform limitation

Slack's documented `admin.users.invite` API requires an Enterprise plan and an
admin user token. The current bot integration has neither a guest-invitation
credential nor an automatic role-conversion path. Do not use undocumented invite
endpoints, browser session tokens, or Slack Connect to bypass this limitation.

Reference: https://docs.slack.dev/reference/methods/admin.users.invite/

Runtime owner: Railway, `bolt/src/onboarding/services/slack.ts`.
Regression checks: `cd bolt && npm test -- src/onboarding/services/slack.test.ts`.
