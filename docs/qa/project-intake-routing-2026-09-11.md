# Canonical private project intake — regression coverage

## Incident and root cause

A channel mention reached the conversational specialist provisioners rather than the current New Project form. The orchestrator prompt still explicitly instructed independent Slack, Frame.io, Harvest and Dropbox creation. This bypassed the durable core project, Control Center, schedule and canvas workflow. A second routing bug treated any reply-thread timestamp as evidence of a DM, allowing a shared-channel project reply to enter an unrelated hours check-in.

## Behavior after deployment

- DM, Assistant, channel mention and `/kit newproject` use the same current intake.
- Authorized producers/admins receive the intake in their verified private Kit DM. Shared channels receive only an ephemeral acknowledgement, without submitted values.
- Recognizable old four-field project replies are intercepted ahead of hours parsing.
- The old four project-provision tools are hidden from model tool definitions and rejected before dispatch, even for an authorized producer/admin in a DM or a stale model tool call.
- Storyboard artifact creation remains available; it is not full project provisioning.
- Old cards, submitted modal metadata, duplicate decisions and recovery destinations cannot redirect provisioning progress into a shared conversation.
- Production provisioning requires the durable Project Control ledger. Old duplicate/replace buttons cannot invoke its disabled legacy fallback.
- Provider work starts only after the current form is submitted; a mention does not create a project.

## Verification

- 554 Bolt tests passed, including 44 new regression cases.
- Actual `app_mention` callback tested in a shared thread with no check-in or LLM invocation.
- DM/Assistant parity, MPIM/private-channel routing, stale numbered intake, role denial, DM failure, and old channel metadata covered.
- Legacy specialist calls rejected before provider dispatch; Boords artifact provision remains in the tool manifest.
- Full workspace typechecks passed.
- Lint ratchet passed without updating its baseline (five fewer existing errors).
- Tests use fictional project/client/budget fixtures only.

## Release and live acceptance

Local tests are not proof of deployment. Merge only through the protected release gates and required independent approval. After rollout, use an authorized test identity to mention Kit with `new project` in a shared thread, verify the current card arrives privately with no external project created, and cancel without submitting. Then complete one deliberately disposable test project through the confirmed form and verify its durable record, sheet rows, canvases, workback and selected provider outputs.

Do not turn an approval gate off to ship this fix. Cleanup of incident-specific provider objects is recorded separately in the service-only deletion audit; that cleanup is not a live test of the unmerged routing code.
