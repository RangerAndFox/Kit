# Kit Studio Browser Worker

This trusted studio-Mac worker creates **private Behance drafts** from approved archive packages, **private ElevenLabs Studio drafts** from storyboard voiceover, and completes **Frame.io project deletion** only after Kit's founder/admin confirmation flow. It uses a dedicated persistent Chrome profile for browser-only operations.

It never publishes:

- Publish controls are disabled in the page before interaction.
- Network requests that look like a publish mutation are blocked.
- The worker only searches for exact `Save`, `Save Draft`, or `Save as Draft` controls.
- The terminal success state is `awaiting_review`; there is no `published` state.
- The producer must open the returned review link and manually publish in Behance.

## One-time studio Mac setup

1. Install Node.js 22 or newer and Google Chrome.
2. Copy `.env.example` to the dedicated worker environment file (the installer defaults to `~/Library/Application Support/Kit/BehanceWorker/.env`). Configure the narrow Kit worker URL and `DROPBOX_SYNC_PATH`. The worker secret lives in macOS Keychain under `com.rangerandfox.kit-studio-worker`; never copy a Supabase service-role key into this machine's worker configuration.
3. Run `npm install` and `npm run build`.
4. Keep `BEHANCE_EXPECTED_PROFILE_SLUG=rangerandfox`, then run `npm run login`. Chrome opens with the dedicated profile. Sign into the Ranger & Fox Adobe/Behance account, return to Terminal, and press Enter. The worker refuses to create drafts under any other Behance profile.
5. Run `npm run login:elevenlabs`, sign into ElevenLabs in the same dedicated profile, return to Terminal, and press Enter.
6. Run `npm run login:frameio`, sign into Frame.io in the same dedicated profile, return to Terminal, and press Enter.
7. Run `npm run check-login` to verify Behance (a normal Chrome profile does not count).
8. Run `scripts/install-macos.sh` to install and start the LaunchAgent. It restarts automatically at login and after a crash.

The browser profile directory contains the Behance and ElevenLabs sessions. It must not be synced, committed, or shared. No provider password is stored in Kit or Supabase. Approved archive media is read through Dropbox's local File Provider mount; Kit's cloud service creates the proof link after the screenshot syncs.

The studio worker has no direct database credential. Its Keychain-backed secret can call only Kit's worker broker operations (heartbeat, claim, fenced progress, and completion); it cannot issue arbitrary Supabase queries.

## Producer workflow

1. Run `/kit archive project` and approve the archive package in Kit's private DM.
2. When preparation finishes, click **Create Behance draft**.
3. The studio worker downloads only the approved archive media and places the approved website copy into separate Behance modules: title/subtitle, opening media, first description, remaining main media, second description, optional Process heading and media, third description, and credits. It then saves the project as a draft and stores a proof screenshot in the project's Dropbox archive.
4. Kit changes the private card to **Review Behance draft**. Open it, review every field, and manually publish only when ready.

## Recovery

- A signed-out or wrong Behance profile changes the worker heartbeat to `needs_login`; rerun `npm run login`. Kit verifies the exact `@rangerandfox` profile before every draft.
- If Behance briefly shows “Only owners can modify projects” for an owned draft, Kit performs one clean authorization reload before pausing for re-authentication.
- A UI change produces a failed job with a precise missing-control error. Kit exposes **Retry Behance draft** after the selector is corrected.
- Worker jobs with no heartbeat for five minutes automatically become retryable.
- An existing draft URL is reused on retry, preventing duplicate projects.

Behance's official help notes that drafts do not auto-save. The worker therefore performs an explicit draft save and captures proof after that save.

## Storyboard voiceover workflow

1. Upload a supported script through Kit's storyboard flow.
2. Kit creates the Boords storyboard. When the script contains voiceover, it also queues a private ElevenLabs Studio job if the account-level Studio API is unavailable.
3. The worker creates or resumes one Studio project, names it after the storyboard project, and enters every VO paragraph as a separate speech clip.
4. The private Studio link appears in Kit's authenticated Control Center when the job completes. It is not posted into a shared project channel.
5. A producer opens the draft, chooses a voice, and generates audio manually if approved.

The ElevenLabs worker never clicks Generate, Share, Export, or Publish. Those controls are blocked in the browser session. A new Studio URL is checkpointed immediately so retries resume the same draft instead of creating duplicates.

## Frame.io project deletion

1. A founder/admin starts `/kit delete project`, reviews the exact inventory, and types the project-specific confirmation in Slack.
2. Kit first tries the official Frame.io API and verifies absence. If the account's v4 API does not expose the documented DELETE route, Kit queues the exact Frame.io project id, URL, and provider-returned name for this worker.
3. The worker finds exactly one matching project row, opens **Delete**, types `delete`, and confirms **Delete Project**. It never deletes a fuzzy or ambiguous name match.
4. Kit independently verifies through the Frame.io API that the project is gone before deleting its own project record. If the worker is offline, signed out, or the UI changes, deletion pauses safely and remains retryable.
