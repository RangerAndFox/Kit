import { z } from 'zod'
import type { KnownBlock } from '@slack/types'
import type { ClaudeTool } from '../llm/tools'
import { KIT_COMMANDS, normalizeCommandRequest, type KitCommandName, type KitCommandRequest } from './command-catalog'

type Tier = 'admin' | 'producer' | 'artist'
type Guide = { title: string; steps: string[]; next: string; start?: KitCommandRequest }

/** Product instructions, not project data. Keep aligned with the canonical handlers. */
export const COMMAND_GUIDES: Record<KitCommandName, Guide> = {
  offboard: {
    title:'Offboard an artist from a project',
    steps:['A producer/admin selects the exact project and artist in the private offboarding picker.', 'Review the memberships to remove, then choose Offboard, Edit or Cancel. No files, time logs, paperwork, other projects or shared accounts are deleted.', 'Check every service result. Retry failed steps; resolve inherited permissions, public links or unsupported invitations manually. The person remains available for other projects.'],
    next:'Want me to open the private offboarding review now?',start:{command:'offboard',args:''},
  },
  onboard: {
    title: 'Add an artist to a project',
    steps: ['Producers and admins can say “Add @Rachel to project 2636”. Kit reuses an existing Slack profile; ambiguous names require an exact mention or email.', 'Review the artist and project, then select Add to project, Edit or Cancel. For a new artist, supply their correct full name and email in the onboarding form.', 'Kit attempts the configured project invitations, including Slack, Dropbox and Frame.io, and adds the artist to the Daily Assignments people list when Project Control is configured. Existing accounts are reused. Check the per-service result for anything needing attention.'],
    next: 'Want me to open the onboarding setup now?', start: { command: 'onboard', args: '' },
  },
  newproject: { title: 'Create a project', steps: ['Open the private New Project form and enter the project identity, ownership, dates and service choices.', 'Review the information before submitting. Keep financial details and client contacts in the private form.', 'Kit provisions the selected services and project-control records. Review the proposed workback with the producer and check any incomplete service steps.'], next: 'Want me to open the new-project setup now?', start: { command: 'newproject', args: '' } },
  update: { title: 'Update a project', steps: ['Choose the existing project from the private picker.', 'Edit the details and review the proposed changes.', 'Confirm the update; Kit uses the existing update workflow to propagate supported changes across connected systems.'], next: 'Want me to open the project-update setup now?', start: { command: 'update', args: '' } },
  archive: { title: 'Archive a project and prepare portfolio drafts', steps: ['Select the project in the private archive workflow.', 'Review the copy, credits, assets and selected destinations.', 'Check each service result and review drafts before publishing; opening the workflow does not publish anything.'], next: 'Want me to open the archive setup now?', start: { command: 'archive', args: 'project' } },
  delete: { title: 'Delete a project', steps: ['An admin selects the exact project in the private deletion workflow.', 'Review the inventory of Kit-owned outputs carefully, then complete the typed confirmation.', 'Check every deletion result. Failed steps pause safely for review; opening the workflow does not delete anything.'], next: 'Want me to open the deletion review now?', start: { command: 'delete', args: 'project' } },
  status: { title: 'Check project status', steps: ['Give Kit the project ID or an unambiguous project name.', 'Ask for the current project status in normal language.', 'The command provides a non-financial lookup. Financial information remains restricted to authorized private conversations.'], next: 'Want to check one now? Tell me the project ID.' },
  dashboard: { title: 'Open the Kit dashboard', steps: ['An admin asks Kit to open the dashboard.', 'Use Open dashboard and sign in with an authorized account.', 'Review health, usage, queues and project operations; a dashboard link does not grant new access.'], next: 'Want me to open the dashboard command now?', start: { command: 'dashboard', args: '' } },
  storyboard: { title: 'Create a storyboard and VO setup', steps: ['Open the storyboard form; provide the storyboard name and script, or choose a blank storyboard.', 'Review the setup before submitting. A script can also be supplied as a supported text or Word file in Kit’s DM.', 'The workflow creates the Boords storyboard and matching ElevenLabs Studio setup using extracted VO when available. Check the result for any provider failures.'], next: 'Want me to open the storyboard setup now?', start: { command: 'storyboard', args: '' } },
  deliver: { title: 'Transcode and deliver a file', steps: ['Choose the source file and a delivery profile in the private delivery form.', 'Review the output requirements before submitting the job.', 'Check the delivery queue for processing and completion; availability depends on the configured workers.'], next: 'Want me to open the delivery setup now?', start: { command: 'deliver', args: '' } },
  profiles: { title: 'Use delivery profiles', steps: ['List the configured profiles to see the available output presets.', 'Choose a suitable preset when submitting a delivery job.', 'To add a preset, ask Kit to create a delivery profile and review the settings.'], next: 'Want me to list the delivery profiles now?', start: { command: 'profiles', args: '' } },
  workers: { title: 'Check render workers', steps: ['An admin opens the worker list to see the reported fleet status.', 'Use the exact hostname when requesting an opt-in or opt-out.', 'Worker commands do not set up an unavailable farm or enable a deferred integration.'], next: 'Want me to show the worker list now?', start: { command: 'workers', args: '' } },
  render: { title: 'Submit an After Effects render', steps: ['Prepare the After Effects project and its render queue.', 'Open the render form, select the source project and review the job.', 'Submit only when the required workers are available, then check render status. This does not enable the phase-two farm.'], next: 'Want me to open the render setup now?', start: { command: 'render', args: '' } },
  access: { title: 'Convert SRT accessibility files', steps: ['Ask Kit for the SRT conversion instructions for the configured Dropbox Delivery-Queue.', 'Place the SRT sidecar with the delivery input as instructed; the existing pipeline produces supported VTT, TTML and TXT outputs.', 'Check accessibility-job status and review the generated files. Asking for instructions alone does not run a conversion.'], next: 'Want me to show the conversion instructions now?', start: { command: 'access', args: 'convert' } },
  celebrate: { title: 'Post or schedule a celebration', steps: ['Tell Kit the event and the public-safe wording.', 'Include a clear date if it should be scheduled rather than posted now.', 'Review the private command card before confirming. The celebration is intended for the team channel, so leave out confidential information.'], next: 'Want to prepare one now? Tell me the occasion and whether it is for now or a particular date.' },
  birthday: { title: 'Set a team birthday', steps: ['Provide the person’s actual Slack @mention and birthday month/day.', 'Check the person and date on the private review card.', 'Confirm to schedule the existing team birthday workflow.'], next: 'Want to set one up? Send the person’s Slack @mention and month/day.' },
  brain: { title: 'Use the project Brain', steps: ['Ask from the relevant project channel to open or refresh its Brain.', 'Ask why a claim is there to see its sources.', 'Producer/admin access and the project’s visibility settings apply. Changing visibility can publish a channel canvas, so review that choice explicitly.'], next: 'Want me to open the Brain command for this conversation now?', start: { command: 'brain', args: '' } },
  role: { title: 'Manage Kit access', steps: ['An admin identifies the person using their exact Slack @mention.', 'Request a role lookup or explicitly name the intended role change.', 'Review the private command details before confirming. Kit roles are separate from provider account permissions.'], next: 'Want to check or change a role? Tell me the person’s Slack @mention and the intended action.' },
  'sync-staff': { title: 'Synchronize staff', steps: ['An admin starts the staff synchronization command.', 'Review before continuing: this reconciles the configured staff and Harvest mappings.', 'Check the reported results and resolve missing or mismatched identities.'], next: 'Want me to open the staff-sync review now?', start: { command: 'sync-staff', args: '' } },
  'sync-projects': { title: 'Reconcile Harvest projects', steps: ['Start with the project-sync preview.', 'Review unmatched projects and the proposed reconciliation.', 'Ask explicitly to apply only after reviewing; a preview does not apply the changes.'], next: 'Want me to open the project-sync preview now?', start: { command: 'sync-projects', args: '' } },
  'backfill-time': { title: 'Review time-log backfill', steps: ['An admin requests a preview of confirmable back-dated check-ins.', 'Review the dates, projects and entries that need attention.', 'Only an explicit apply request should log a backfill to Harvest.'], next: 'Want me to open the backfill preview now?', start: { command: 'backfill-time', args: '' } },
  meme: { title: 'Post the timesheet meme', steps: ['An admin asks Kit to post the weekly timesheet meme.', 'Review the private command card.', 'Confirm to post it to the configured team channel. For a custom event, use the celebration workflow instead.'], next: 'Want me to open the meme review now?', start: { command: 'meme', args: '' } },
  note: { title: 'Save a project note', steps: ['Identify the project, or ask within its project channel.', 'Give Kit the note you want saved.', 'Review the private request before confirming. Keep confidential notes out of shared conversations.'], next: 'Want to save a note now? Send the project ID and note in a private DM.' },
  pilot: { title: 'Use a visual-development pilot', steps: ['Start with pilot help or readiness for the intended project.', 'Use the exact identifiers when adding references, generations and evidence.', 'Review and finalize through the existing validation workflow; the feature must be enabled first.'], next: 'Want me to open pilot help now?', start: { command: 'pilot', args: 'help' } },
  help: { title: 'Get help using Kit', steps: ['Ask in a DM or @mention Kit with a question about a feature.', 'Kit explains the steps and any access restrictions first.', 'If you want to proceed, start the private workflow and review its details before confirming.'], next: 'Want me to show the command list now?', start: { command: 'help', args: '' } },
}

export const guidanceRequestSchema = z.object({ command: z.enum(Object.keys(KIT_COMMANDS) as [KitCommandName, ...KitCommandName[]]) }).strict()
export const EXPLAIN_KIT_COMMAND_TOOL: ClaudeTool = {
  name: 'explain_kit_command',
  description: 'Read-only instructions for a Kit function. Use when asked how to use a feature, how it works, or for a walkthrough. Returns verified product steps and an optional invitation to start; NEVER runs a command or creates a command request. Choose the single relevant command; ask a clarifying question if ambiguous. Do not invent capabilities. Commands: ' + Object.keys(KIT_COMMANDS).join(', '),
  input_schema: { type: 'object', properties: { command: { type: 'string', enum: Object.keys(KIT_COMMANDS) } }, required: ['command'] },
}

export function isGuidanceQuestion(text: string): boolean {
  const value = normalizeCommandRequest(text)
  return /^(?:how\s+(?:do|does|can|could|would|should|to)\b|(?:show|tell|teach|walk|talk|guide)\s+(?:me|us)\s+(?:how|through)\b|(?:explain|instructions|guidance|walkthrough|tutorial)\b|what(?:'s| is| are)\s+(?:the\s+)?(?:process|steps|way)\b)/i.test(value)
    || /^what\s+do\s+(?:i|we)\s+need\s+(?:to|for)\b/i.test(value)
    || /^(?:what (?:is|does)|what's|tell me about)\b.*\b(?:onboarding|offboarding|archiving|provisioning|storyboards?|delivery profiles?|backfill|accessibility|srt conversion|kit commands?|kit functions?)\b/i.test(value)
    || /\b(?:need|want|like)\s+(?:some\s+)?(?:guidance|instructions|a walkthrough|pointers)\b/i.test(text)
}

export function parseGuidanceCommand(text: string): KitCommandName | null {
  if (!isGuidanceQuestion(text)) return null
  const matches: KitCommandName[] = []
  const topics: [KitCommandName, RegExp][] = [
    ['offboard', /\b(?:offboard\w*|remov\w*\s+(?:(?:an?|the)\s+)?(?:artist|freelancer|contractor))\b/i],
    ['onboard', /\b(?:onboard\w*|(?:add(?:ing)?|invit\w*|set\w*\s+up|get\w*)\b.*\b(?:artist|freelancer|contractor))\b/i],
    ['newproject', /\b(?:creat\w*|new|provision\w*|start|set up)\b.*\bproject\b/i],
    ['update', /\b(?:edit|updat\w*|change)\b.*\bproject\b/i],
    ['archive', /\b(?:archiv\w*|portfolio|behance|vimeo|wordpress|social drafts)\b/i],
    ['delete', /\b(?:delet\w*|remov\w*)\s+(?:(?:a|the)\s+)?project\b/i],
    ['dashboard', /\b(?:dashboard|control center|health and usage)\b/i],
    ['storyboard', /\b(?:storyboard\w*|boords|elevenlabs)\b/i],
    ['status', /\bproject (?:status|tracking)\b/i],
    ['deliver', /\b(?:transcod\w*|delivery jobs?|delivery queue)\b/i],
    ['profiles', /\b(?:profiles?|presets?)\b/i], ['workers', /\b(?:workers?|fleet|render farm)\b/i],
    ['render', /\b(?:after effects|aerender)\b/i], ['access', /\b(?:srt|caption\w*|accessibility|vtt|ttml)\b/i],
    ['celebrate', /\bcelebrat\w*\b/i], ['birthday', /\bbirthdays?\b/i], ['brain', /\bbrain\b/i],
    ['role', /\b(?:roles?|access tiers?|permissions?)\b/i], ['sync-staff', /\b(?:sync\w*|reconcil\w*)\b.*\bstaff\b/i],
    ['sync-projects', /\b(?:sync\w*|reconcil\w*)\b.*\b(?:harvest|projects)\b/i],
    ['backfill-time', /\bbackfill\w*\b/i], ['meme', /\bmemes?\b/i], ['note', /\b(?:save|add|record)\b.*\bnotes?\b/i],
    ['pilot', /\b(?:pilots?|visual.development)\b/i], ['help', /\b(?:commands?|help|functions?|features?)\b/i],
  ]
  for (const [command, pattern] of topics) if (pattern.test(text)) matches.push(command)
  return matches.length === 1 ? matches[0] : null
}

export function guidanceCanStart(command: KitCommandName, tier?: Tier): boolean {
  const rank = { artist: 0, producer: 1, admin: 2 }
  return !!tier && rank[tier] >= rank[KIT_COMMANDS[command].tier] && !!COMMAND_GUIDES[command].start
}

export function guidanceText(command: KitCommandName, tier?: Tier): string {
  const guide = COMMAND_GUIDES[command]
  const required = KIT_COMMANDS[command].tier
  const allowed = !!tier && ({ artist: 0, producer: 1, admin: 2 }[tier] >= { artist: 0, producer: 1, admin: 2 }[required])
  const access = required === 'artist' ? 'Available to recognized Kit users.' : required === 'admin' ? 'Admin only.' : 'Producer/admin only.'
  const invitation = allowed ? guide.next + (guide.start ? ' Choose Start privately below, or reply “yes” in this thread. Nothing runs until you review and confirm.' : '') : `To proceed, ask ${required === 'admin' ? 'an admin' : 'your producer or an admin'} for help. Nothing has run.`
  return `*${guide.title}*\n\n${guide.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\n${access}\n\n${invitation}`
}

export function guidanceBlocks(command: KitCommandName, tier?: Tier): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: guidanceText(command, tier) } }]
  if (guidanceCanStart(command, tier)) blocks.push({ type: 'actions', elements: [
    { type: 'button', action_id: 'kit_guidance_start', text: { type: 'plain_text', text: 'Start privately' }, value: command },
    { type: 'button', action_id: 'kit_guidance_dismiss', text: { type: 'plain_text', text: 'Not now' }, value: command },
  ] })
  return blocks
}
