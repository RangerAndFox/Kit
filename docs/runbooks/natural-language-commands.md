# Kit: natural-language commands

Every live `/kit` command family and `/storyboard` is now represented in the shared command catalog. Users can DM Kit or actually @mention Kit in a channel; slash commands still work. Common phrasings route without a model call. Looser wording uses the existing orchestrator's `open_kit_command` tool, which can only offer a private review card—not execute an operation.

## Examples

| Feature | Ask Kit |
| --- | --- |
| Help | What can you do? |
| Dashboard | Show me the dashboard |
| New project | Kit, make a new project |
| Project edits | Edit project 2637 |
| Project status | Check the status of project 2637 |
| Archive / portfolio drafts | Prepare project 2637 for the website and social |
| Delete everywhere | Delete project 9999 |
| Freelancer onboarding | Add a new freelancer |
| Storyboard / VO | Create a new storyboard |
| Storyboard resume | Resume storyboard job [job ID] |
| Delivery / transcode | Transcode a video; show the delivery queue |
| Delivery profiles | List delivery profiles; create a new delivery profile |
| Worker fleet | Show the render workers; opt this exact worker out |
| AE renders | Render an After Effects project; check render jobs |
| Accessibility | Show accessibility status; convert my SRT to VTT |
| Celebrations | Celebrate we finished the cut |
| Birthdays | Save birthday for @person 03-14 |
| Brain / sources / visibility | Refresh the project brain; show the sources behind this claim |
| Roles | Give @person producer access |
| Staff synchronization | Sync staff with Harvest |
| Project reconciliation | Preview projects from Harvest |
| Time backfill | Preview missing time logs |
| Timesheet meme | Post a timesheet meme |
| Notes | Remember that boards are approved for 2637 |
| Visual development pilots | Show the visual development pilot readiness |

Pilot subcommands are included in the model catalog and still use their existing validated parser and feature gate. Missing IDs/enums require clarification. This does not enable phase-2 render infrastructure.

Hours and Frame.io auto-upload already have dedicated natural-language handlers. Hours retain Confirm/Redo and date confirmation. Upload toggles retain producer/admin authorization and explicit project resolution; negative/conditional phrases are rejected. File uploads, sheet edits and scheduled automations keep their existing triggers.

SRT conversion is an existing automatic Dropbox Delivery-Queue workflow. The conversational entry explains where to put the SRT; opening that instruction does not convert a file. Video accessibility job status is separate from standalone SRT conversion.

## Review and safety

- New-project requests continue to open the verified private current form; submission is still required.
- Other recognized command actions offer **Continue / Cancel** in the requester's verified DM. Details are shown before execution. Commands that require a form use the button's fresh Slack trigger.
- On Continue, Kit invokes the same registered handler as the slash command. Project-selection, preview, onboarding, publishing and typed-deletion confirmations remain intact. A requested project code is a hint for review; a picker still makes the selection explicit.
- The model cannot supply actor, workspace, destination or trigger IDs. Only allowlisted command names and bounded argument strings are accepted.
- Team/workspace and current role are checked before offering a card and again on click. Sensitive and operational commands are conservatively producer/admin-only; deletion, roles, staff sync, reconciliation, backfill, workers, dashboard and the timesheet meme require admin access. Help and non-financial project lookup are available to artists.
- Card buttons carry opaque IDs, not command arguments. Requests are persisted in a service-only RLS-protected table, bound to the actor, Slack team and DM. Card expiry is 30 minutes.
- Atomic pending-to-running claims prevent double execution. Crashed/uncertain commands are never automatically replayed. Completed/cancelled/review receipts erase argument contents; unhandled expired rows remain service-only for operational inspection.
- The canonical command reports its outcome. A completed router receipt means the handler returned, not that every downstream provider job completed.
- Ordinary responses are redirected privately. Explicit celebration/meme actions still post to the team channel after confirmation; Brain canvas changes still respect that workflow's visibility setting.

## Release and acceptance

Apply the `natural_command_requests` migration before the Bolt deployment. Repository command coverage tests fail if a slash command is added without catalog coverage. Run Bolt tests, all typechecks, lint ratchet and protected CI gates. Verify the deployed commit and real Slack-connected Railway health; a Vercel preview is not a Bolt deployment.

Production-safe acceptance: ask Kit for help in a DM, click Continue, and verify the command list; ask for a storyboard or onboarding form and cancel without submitting. Verify a channel request opens a private review card and that another actor cannot run it. Do not create/delete real projects just to test recognition.
