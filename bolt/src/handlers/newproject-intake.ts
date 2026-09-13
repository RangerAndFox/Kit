import type { WebClient } from '@slack/web-api'
import { canOnboard } from '../onboarding/permissions'
import { buildNewProjectCard } from './newproject-card'

/** Strip only direct-address/request prefixes, never arbitrary prose or quotes. */
function projectRequestText(value: string): string {
  // app_mention may already have removed @Kit, leaving its comma/colon behind.
  let intent = value.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().replace(/^[,!:—–-]+\s*/, '')
  const prefix = /^(?:(?:hey|hi|hello|kit|please)\b[\s,!:—–-]*|(?:can|could|would|will)\s+you\b[\s,!:—–-]*|let's\s+|(?:i|we)(?:\s+(?:need|want|would like)|'d like)\s+(?:you\s+to\s+|to\s+)?|help\s+(?:me|us)\s+(?:to\s+)?)/i
  while (prefix.test(intent)) intent = intent.replace(prefix, '')
  return intent
}

/**
 * Recognize a request to OPEN intake, not permission to provision providers.
 * Shared by all inbound routes; deliberately independent of LLM interpretation.
 */
export function isNewProjectTrigger(text: string): boolean {
  const value = String(text || '').replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, '').trim()
  if (!value) return false
  // Catch replies to the retired four-field intake before an open hours
  // check-in can consume them. Do not extract or echo their sensitive values.
  if (/project\s*(?:id|number)\s*:/i.test(value) && /client\s*:/i.test(value) && /project\s*name\s*:/i.test(value)) return true
  if (/^1[.)]\s*\d{4,6}[A-Z]?\s*\n2[.)]\s*[^\n]+\n3[.)]\s*[^\n]+\n4[.)]\s*(?:\$?[\d,.]+\s*[kK]?|T&M|none|no budget)\s*$/i.test(value)) return true

  const intent = projectRequestText(value)
  const request = intent.match(/^(?:\/kit\s+)?\/?new\s*project\b(.*)$/i)
    || intent.match(/^(?:(?:(?:a|another)\s+)?new project|new gig)\b(.*)$/i)
    || intent.match(/^(?:make|create|start|add|provision|set[ -]?up|spin[ -]?up|kick[ -]?off)\s+(?:(?:me|us)\s+)?(?:(?:a|the|another)\s+)?(?:brand[ -]new\s+|new\s+)?project\b(.*)$/i)
    || intent.match(/^(?:set|spin)\s+(?:(?:me|us)\s+)?(?:(?:a|the|another)\s+)?new project\s+up\b(.*)$/i)
    || intent.match(/^get\s+(?:(?:me|us)\s+)?(?:(?:a|another)\s+)?new project\s+(?:started|going)\b(.*)$/i)
  if (!request) return false

  // A project *resource* request is not a request for a whole new project.
  // Check before punctuation cleanup so possessives are handled explicitly.
  const tail = request[1].trim()
  if (/^(?:'s\s+)?(?:tabs?|canvases?|folders?|schedules?|workbacks?|boards?|storyboards?|reports?|updates?|briefs?|templates?|links?|statuses|status|files?|tasks?|assignments?|budgets?|invoices?|proposals?|channels?|names?|descriptions?|overviews?|references?)\b/i.test(tail)) return false

  // Require an intake-like continuation. This keeps "new project is delayed",
  // quoted examples, negated requests and hours narratives out of the shortcut.
  // Descriptions are never extracted/echoed here; the producer reviews the form.
  return /^(?:[.!?,]*\s*(?:(?:please|thanks|thank you|now|today|for me|for us)[.!?,]*)?$|(?:for|with|called|named|titled|in|using)\b|(?:id|number)\s*[:#]?\s*\d|#?\d{4,6}[A-Z]?\b|:\s*\S)/i.test(tail)
}

/** Never trust a card's channel metadata as an authorization/privacy boundary. */
export async function resolvePrivateProjectIntake(
  client: Pick<WebClient, 'conversations'>,
  userId: string,
  sourceChannel?: string,
  sourceThread?: string,
): Promise<{ channelId: string; threadTs?: string }> {
  const opened = await client.conversations.open({ users: userId })
  const channelId = opened.channel?.id
  if (!opened.ok || !channelId?.startsWith('D')) throw new Error('Could not open a private project intake DM')
  return { channelId, threadTs: sourceChannel === channelId ? sourceThread : undefined }
}

/** Shared by DM, @mention and slash-command routes. No provider work starts here. */
export async function sendNewProjectIntake(opts: {
  client: Pick<WebClient, 'chat' | 'conversations' | 'users'>
  userId: string
  channelId: string
  threadTs?: string
}): Promise<void> {
  const { client, userId, channelId, threadTs } = opts
  const notify = async (text: string) => {
    await client.chat.postEphemeral({ channel: channelId, user: userId, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
  }
  try {
    const info = await client.users.info({ user: userId })
    if (!(await canOnboard(userId, { email: info.user?.profile?.email }))) {
      await notify(':no_entry: Only producers and admins can create projects.')
      return
    }
    const target = await resolvePrivateProjectIntake(client, userId, channelId, threadTs)
    await client.chat.postMessage(buildNewProjectCard(target.channelId, target.threadTs))
    if (target.channelId !== channelId) {
      await notify('I sent the current New Project form to your private DM with Kit. Complete and submit it there; no project has been created yet.')
    }
  } catch {
    // Fail closed: do not fall back to the conversational/legacy provisioner.
    await notify(':warning: I couldn’t open the private New Project form. Please DM Kit and type “new project”. No project was created.')
  }
}
