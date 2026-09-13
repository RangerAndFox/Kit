# Natural-language project intake

## User experience

Producers/admins can DM Kit with “Kit, make a new project”, “Can you make us a project for Acme?”, “We need a new project”, or “Let's get a new project started.” In a channel, use a real `@Kit` mention so Slack delivers the request. No exact phrase or slash command is needed.

All recognized requests enter the existing role-gated, verified private-DM intake. Shared-channel acknowledgements are ephemeral and do not repeat submitted project details. The producer must open, review and submit the current form before any external project is provisioned. This change does not extract project fields from prose, alter permissions, or allow conversational specialist provisioning.

Negations, quoted examples, how-to questions, ordinary hours reports and project-resource requests (for example, creating a schedule rather than a project) remain outside the shortcut. Unrecognized/ambiguous language still uses the existing conversational path; the prompt asks for clarification without claiming side effects.

## Cause and implementation

The `main` branch inspected on September 13 still used a short exact-phrase list with a 60-character limit. The canonical intake fix in PR #175 remained unmerged with independent review required. The expanded shared matcher adds direct-address/polite-request normalization, recipient words, project-creation verb variants, and guarded continuations. It also handles punctuation left behind when Slack removes an app mention.

## Verification

- Added 93 tests: 40 natural phrasings, 33 negative controls, and 20 routing/check-in cases.
- Focused intake, routing and intent-parser tests: 146 passed.
- Full Bolt suite: 647 passed across 61 files.
- Root, Bolt and tools TypeScript checks passed.
- ESLint ratchet passed without changing the baseline.
- Tests use fictional identities; no real project, provider asset or Slack message is created.

## Release acceptance still required

Repository tests do not prove deployment. Ship with the canonical intake fix through the existing protected PR, CI and independent review; do not bypass those gates. After production rollout, an authorized producer should DM “Kit make a new project”, then try `@Kit, can you make us a project?` in a channel thread. Verify that both open the same private setup card, no project is created before submission, shared acknowledgements reveal no details, and Cancel leaves no provider objects. Do not provision a real project merely to test recognition.
