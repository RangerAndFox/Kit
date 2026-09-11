import type { WebClient } from '@slack/web-api'
import { canOnboard } from '../onboarding/permissions'
import { buildNewProjectCard } from './newproject-card'

/** Explicit creation intent, not a passing mention in a time-log reply. */
export function isNewProjectTrigger(text: string): boolean {
  const value = String(text || '').replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, '').trim()
  if (!value) return false
  const intent = value.replace(/^(?:(?:hey\s+)?kit[,!]?\s+)?(?:(?:please|can you|could you|would you|let['’]s|i(?:'d| would) like to|i want to|we need to)\s+)*/i, '')
  if (/^(?:new|make|create|start|set up|setup|provision|spin up)\s+(?:(?:a|the)\s+)?(?:new\s+)?project\s+(?:tabs?|canvases?|folders?|schedules?|boards?|storyboards?|reports?|updates?)\b/i.test(intent)) return false
  if (/^(?:\/kit\s+)?\/?new\s*project\b/i.test(intent)) return true
  if (/^(?:new gig|(?:make|create|start|set up|setup|provision|spin up)\s+(?:(?:a|the)\s+)?(?:new\s+)?project)\b/i.test(intent)) return true
  // Catch replies to the retired four-field intake before an open hours
  // check-in can consume them. Do not extract or echo their sensitive values.
  if (/project\s*(?:id|number)\s*:/i.test(value) && /client\s*:/i.test(value) && /project\s*name\s*:/i.test(value)) return true
  return /^1[.)]\s*\d{4,6}[A-Z]?\s*\n2[.)]\s*[^\n]+\n3[.)]\s*[^\n]+\n4[.)]\s*(?:\$?[\d,.]+\s*[kK]?|T&M|none|no budget)\s*$/i.test(value)
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
