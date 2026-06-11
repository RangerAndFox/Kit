/**
 * Slack Agent — Communication & Collaboration Expert
 *
 * Knows everything about the studio's Slack workspace: channels,
 * messages, canvases, users, and notifications. Kit routes any
 * communication, notification, or channel management question here.
 */

import {
  createProjectSlackChannel,
  postProjectLinks,
  duplicateTemplateCanvases,
} from '@/lib/mcp/slack'
import { workbookConfigFromEnv, projectControlCreationEnabled } from '@/lib/project-control/types'
import { resolveControlTemplate } from '@/lib/project-control/canvas'
import type { AgentDefinition, AgentResult } from './types'

const SLACK_API = 'https://slack.com/api'

function slackHeaders() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
  }
}

async function slackPost(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: slackHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    // Accept either `client` or `clientName` for client identity — the
    // modal flow sends `clientName`, while NL specialists tend to send `client`.
    const client = (payload.client as string) || (payload.clientName as string) || ''
    const projectName = (payload.projectName as string) || ''
    if (!client || !projectName) {
      return {
        agent: 'slack',
        action: 'provision',
        success: false,
        error: `Slack provision needs both \`client\` and \`projectName\` (got client="${client}", projectName="${projectName}")`,
      }
    }

    // Auto-invite the requesting user, the PM, and the selected team members so
    // the channel isn't an empty room. Dedupe + drop falsy.
    const inviteUserIds: string[] = Array.from(
      new Set(
        [
          payload.slackUserId as string | undefined,
          payload.projectManager as string | undefined,
          ...((payload.teamMembers as string[] | undefined) || []),
        ].filter((id): id is string => !!id),
      ),
    )

    const channel = await createProjectSlackChannel({
      projectId: payload.projectId as string,
      projectName,
      client,
      projectNumber: (payload.projectNumber as string) || undefined,
      projectType: payload.projectType as string | undefined,
      targetDelivery: payload.targetDelivery as string | undefined,
      inviteUserIds: inviteUserIds.length > 0 ? inviteUserIds : undefined,
    })

    // Post collected links if any
    const links: Record<string, string> = {}
    const collected = payload.collectedLinks as Record<string, string> | undefined
    if (collected) {
      if (collected.harvest) links['Harvest'] = collected.harvest
      if (collected.dropbox) links['Dropbox'] = collected.dropbox
      if (collected.frameio) links['Frame.io'] = collected.frameio
      if (collected.canva) links['Canva'] = collected.canva
    }
    if (Object.keys(links).length > 0) {
      await postProjectLinks({ channelId: channel.channelId, links })
    }

    // Project Control: when the workbook is configured, resolve the single
    // Project Control template so it is EXCLUDED from generic cloning and
    // managed through its own dedicated create/sync path (creation.ts). If it
    // can't be resolved (0/2+ matches), we don't guess — we surface the reason
    // and let generic cloning proceed; the binding step records the error.
    let controlTemplate: { fileId: string; markdown: string; hash: string } | null = null
    let controlTemplateError: string | null = null
    const excludeFileIds: string[] = []
    // Fail closed: when template resolution is uncertain we skip generic canvas
    // cloning ENTIRELY, so no unmanaged Project-Control-like canvas is created.
    let skipGenericClone = false
    if (projectControlCreationEnabled() && workbookConfigFromEnv()) {
      try {
        const r = await resolveControlTemplate(workbookConfigFromEnv()!)
        if (r.ok) {
          controlTemplate = { fileId: r.fileId, markdown: r.markdown, hash: r.hash }
          excludeFileIds.push(r.fileId)
          // A valid match found under partial enumeration: bind it, but don't
          // generically clone (an unread candidate could be control-like).
          if (!r.cloneSafe) skipGenericClone = true
        } else {
          controlTemplateError = r.reason
          // Exclude every matched (and configured) candidate from generic clone…
          excludeFileIds.push(...r.excludeFileIds)
          // …and if resolution was uncertain, don't clone anything at all.
          if (!r.cloneSafe) skipGenericClone = true
        }
      } catch (e: any) {
        controlTemplateError = `resolve_failed: ${e.message}`
        skipGenericClone = true
      }
    }

    // Duplicate canvases from the template channel (header canvas + standalones).
    // Skipped entirely when template resolution was uncertain — cloning here
    // could otherwise clone a Project-Control-like canvas we failed to exclude.
    let canvasResult: { standaloneCanvasIds: string[] } = {
      standaloneCanvasIds: [],
    }
    if (skipGenericClone) {
      console.warn(
        `[SlackAgent] skipping generic canvas clone — Project Control template resolution uncertain (${controlTemplateError}); not cloning to avoid an unmanaged control-like canvas`,
      )
    } else {
      try {
        canvasResult = await duplicateTemplateCanvases({
          newChannelId: channel.channelId,
          projectName,
          projectNumber: (payload.projectNumber as string) || undefined,
          client,
          projectType: (payload.projectType as string) || undefined,
          producerSlackId: (payload.projectManager as string) || undefined,
          cdSlackId: (payload.creativeDirector as string) || undefined,
          delivery: (payload.targetDelivery as string) || undefined,
          dropboxUrl: (payload.dropboxUrl as string) || undefined,
          frameioUrl: (payload.frameioUrl as string) || undefined,
          excludeFileIds,
        })
      } catch (e: any) {
        console.warn('[SlackAgent] Template canvas copy failed (non-fatal):', e.message)
      }
    }
    const totalCanvases = canvasResult.standaloneCanvasIds.length

    return {
      agent: 'slack',
      action: 'provision',
      success: true,
      url: channel.url,
      id: channel.channelId,
      message: `Created #${channel.channelName}${totalCanvases ? ` with ${totalCanvases} canvas${totalCanvases === 1 ? '' : 'es'}` : ''}`,
      data: {
        channelName: channel.channelName,
        channelId: channel.channelId,
        standaloneCanvasIds: canvasResult.standaloneCanvasIds,
        controlTemplate,
        controlTemplateError,
      },
    }
  } catch (err: any) {
    return { agent: 'slack', action: 'provision', success: false, error: err.message }
  }
}

async function sendMessage(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const channel = payload.channel as string
    const text = payload.text as string
    const threadTs = payload.threadTs as string | undefined

    const body: Record<string, unknown> = { channel, text }
    if (threadTs) body.thread_ts = threadTs

    const data = await slackPost('chat.postMessage', body)

    return {
      agent: 'slack',
      action: 'send_message',
      success: true,
      message: `Message sent to ${channel}`,
      data: { channel, ts: data.ts, threadTs },
    }
  } catch (err: any) {
    return { agent: 'slack', action: 'send_message', success: false, error: err.message }
  }
}

async function findChannel(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const query = (payload.query as string).toLowerCase()
    const data = await slackPost('conversations.list', {
      types: 'public_channel,private_channel',
      limit: 200,
      exclude_archived: true,
    })

    const matches = (data.channels || [])
      .filter((ch: any) =>
        ch.name.toLowerCase().includes(query) ||
        (ch.topic?.value || '').toLowerCase().includes(query)
      )
      .slice(0, 10)
      .map((ch: any) => ({
        id: ch.id,
        name: ch.name,
        topic: ch.topic?.value || '',
        memberCount: ch.num_members,
      }))

    return {
      agent: 'slack',
      action: 'find_channel',
      success: true,
      message: `Found ${matches.length} channel(s) matching "${query}"`,
      data: { matches },
    }
  } catch (err: any) {
    return { agent: 'slack', action: 'find_channel', success: false, error: err.message }
  }
}

async function findUser(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const query = (payload.query as string).toLowerCase()
    const data = await slackPost('users.list', { limit: 200 })

    const matches = (data.members || [])
      .filter((u: any) =>
        !u.deleted &&
        !u.is_bot &&
        (u.real_name?.toLowerCase().includes(query) ||
         u.profile?.display_name?.toLowerCase().includes(query) ||
         u.name?.toLowerCase().includes(query))
      )
      .slice(0, 10)
      .map((u: any) => ({
        id: u.id,
        name: u.real_name || u.name,
        displayName: u.profile?.display_name || '',
        email: u.profile?.email || '',
        title: u.profile?.title || '',
      }))

    return {
      agent: 'slack',
      action: 'find_user',
      success: true,
      message: `Found ${matches.length} user(s) matching "${query}"`,
      data: { matches },
    }
  } catch (err: any) {
    return { agent: 'slack', action: 'find_user', success: false, error: err.message }
  }
}

async function setChannelTopic(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const channel = payload.channel as string
    const topic = payload.topic as string
    await slackPost('conversations.setTopic', { channel, topic })

    return {
      agent: 'slack',
      action: 'set_topic',
      success: true,
      message: `Updated topic for ${channel}`,
      data: { channel, topic },
    }
  } catch (err: any) {
    return { agent: 'slack', action: 'set_topic', success: false, error: err.message }
  }
}

async function getChannelHistory(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const channel = payload.channel as string
    const limit = (payload.limit as number) || 20

    const data = await slackPost('conversations.history', { channel, limit })
    const messages = (data.messages || []).map((m: any) => ({
      ts: m.ts,
      user: m.user,
      text: m.text?.slice(0, 300),
      type: m.subtype || 'message',
      threadReplies: m.reply_count || 0,
    }))

    return {
      agent: 'slack',
      action: 'get_history',
      success: true,
      message: `${messages.length} recent messages`,
      data: { channel, messages },
    }
  } catch (err: any) {
    return { agent: 'slack', action: 'get_history', success: false, error: err.message }
  }
}

// ─── Agent Definition ──────────────────────────────────────

export const slackAgent: AgentDefinition = {
  id: 'slack',
  name: 'Slack Agent',
  domain: 'Slack',
  expertise:
    'Team communication, project channels, canvases, notifications, user lookup, and channel management. Ask me to send messages, find channels or people, check channel history, create project channels with canvases, or manage channel topics and notifications.',
  requiredEnvVars: ['SLACK_BOT_TOKEN'],
  capabilities: [
    {
      action: 'provision',
      description: 'Create a project Slack channel with welcome message, project canvas, and provisioned links',
      inputDescription:
        'projectName (required), client (required), projectNumber (the project ID, e.g. "2654"), projectType, projectManager (Slack user ID), teamMembers (array of Slack user IDs), targetDelivery, briefSummary',
      mutates: true,
    },
    {
      action: 'send_message',
      description: 'Send a message to a channel or thread',
      inputDescription: 'channel (ID or name), text, threadTs (optional for replies)',
      mutates: true,
    },
    {
      action: 'find_channel',
      description: 'Search for channels by name or topic',
      inputDescription: 'query (search term)',
      mutates: false,
    },
    {
      action: 'find_user',
      description: 'Find a Slack user by name, display name, or username',
      inputDescription: 'query (name to search)',
      mutates: false,
    },
    {
      action: 'set_topic',
      description: 'Update the topic of a channel',
      inputDescription: 'channel (ID), topic (new topic text)',
      mutates: true,
    },
    {
      action: 'get_history',
      description: 'Get recent messages from a channel',
      inputDescription: 'channel (ID), limit (optional, default 20)',
      mutates: false,
    },
  ],
  handler: async (action, payload) => {
    switch (action) {
      case 'provision':
        return provision(payload)
      case 'send_message':
        return sendMessage(payload)
      case 'find_channel':
        return findChannel(payload)
      case 'find_user':
        return findUser(payload)
      case 'set_topic':
        return setChannelTopic(payload)
      case 'get_history':
        return getChannelHistory(payload)
      default:
        return { agent: 'slack', action, success: false, error: `Unknown action: ${action}` }
    }
  },
}
