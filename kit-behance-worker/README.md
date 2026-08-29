# Kit Behance Worker

This trusted studio-Mac worker turns an approved Kit archive package into a **private Behance draft**. It uses a dedicated persistent Chrome profile because Behance does not provide a supported write API.

It never publishes:

- Publish controls are disabled in the page before interaction.
- Network requests that look like a publish mutation are blocked.
- The worker only searches for exact `Save`, `Save Draft`, or `Save as Draft` controls.
- The terminal success state is `awaiting_review`; there is no `published` state.
- The producer must open the returned review link and manually publish in Behance.

## One-time studio Mac setup

1. Install Node.js 22 or newer and Google Chrome.
2. Copy `.env.example` to `.env` and fill in the Supabase service-role and Dropbox credentials already used by Kit. Keep this file only on the trusted studio Mac.
3. Run `npm install` and `npm run build`.
4. Run `npm run login`. Chrome opens with the dedicated profile. Sign into the Ranger & Fox Adobe/Behance account, return to Terminal, and press Enter.
5. Run `npm start`. Leave the worker running, or configure macOS LaunchAgent/your process manager to run `npm run start:prod` at login.

The browser profile directory contains the Behance session. It must not be synced, committed, or shared. No Behance password is stored in Kit or Supabase.

## Producer workflow

1. Run `/kit archive project` and approve the archive package in Kit's private DM.
2. When preparation finishes, click **Create Behance draft**.
3. The studio worker downloads only the approved archive media, populates the Behance editor, saves the project as a draft, and stores a proof screenshot in the project's Dropbox archive.
4. Kit changes the private card to **Review Behance draft**. Open it, review every field, and manually publish only when ready.

## Recovery

- A signed-out profile changes the worker heartbeat to `needs_login`; rerun `npm run login`.
- A UI change produces a failed job with a precise missing-control error. Kit exposes **Retry Behance draft** after the selector is corrected.
- Worker jobs with no heartbeat for five minutes automatically become retryable.
- An existing draft URL is reused on retry, preventing duplicate projects.

Behance's official help notes that drafts do not auto-save. The worker therefore performs an explicit draft save and captures proof after that save.
