/**
 * Slack Event Handlers
 *
 * Handles events:
 * - app_mention — @Kit mention in channels
 * - message — detect unanswered questions
 *
 * @module slack/events
 */

import { createClient } from '@supabase/supabase-js';

// Type declarations for Slack
type SlackEvent = any;
type SlackContext = any;

/**
 * Handle @Kit mentions in channels
 *
 * When someone mentions Kit in a channel:
 * 1. Extract the question/request
 * 2. Route through Ask Kit pipeline with workspace context
 * 3. Reply in thread with answer + source citations
 *
 * @param payload - Slack event payload
 */
export async function handleAppMention(payload: SlackEvent): Promise<void> {
  const { event, team_id, client, channel_id, thread_ts, ts } = payload;

  // Extract text after @Kit mention
  const mentionText = event.text;
  const questionMatch = mentionText.match(/<@U[\w]+>\s*(.+)/);
  const question = questionMatch ? questionMatch[1].trim() : '';

  if (!question) {
    // Just mentioned Kit without a question
    await sendThreadReply(client, channel_id, thread_ts || ts, {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Hi there! Ask me anything about your projects, timeline, or team. I'm here to help.",
      },
    });
    return;
  }

  try {
    // Fetch workspace context
    const workspaceData = await getWorkspaceContext(team_id);
    if (!workspaceData) {
      await sendThreadReply(client, channel_id, thread_ts || ts, {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "I couldn't find workspace data. Is Kit properly installed?",
        },
      });
      return;
    }

    // Route to Ask Kit (placeholder for actual Claude integration)
    const response = await askKitQuestion(question, workspaceData);

    // Build response blocks with citations
    const blocks = buildAskResponse(response, question);

    // Send reply in thread
    await sendThreadReply(client, channel_id, thread_ts || ts, ...blocks);

    // Save conversation to history
    await saveConversationHistory(team_id, {
      channel_id,
      thread_ts: thread_ts || ts,
      user_id: event.user,
      question,
      response: response.answer,
      citations: response.citations,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Error handling app mention:', error);
    await sendThreadReply(client, channel_id, thread_ts || ts, {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Sorry, I encountered an error. Please try again.",
      },
    });
  }
}

/**
 * Handle message events to detect unanswered questions
 *
 * Pattern: If a message ends with "?" and receives no thread replies
 * within 5 minutes, Kit offers to help
 *
 * @param payload - Slack event payload
 */
export async function handleMessageEvent(payload: SlackEvent): Promise<void> {
  const { event, team_id, client } = payload;

  // Skip bot messages and messages with threads already
  if (event.bot_id || event.thread_ts) {
    return;
  }

  // Check if message ends with question mark
  if (!event.text?.trim().endsWith('?')) {
    return;
  }

  // In production, this would:
  // 1. Set a 5-minute timer
  // 2. Check if thread has replies after 5 minutes
  // 3. If not, offer to help

  // For now, log the structure
  console.log('Question detected in channel:', {
    channel: event.channel,
    user: event.user,
    text: event.text,
    timestamp: event.ts,
  });

  // Would implement delayed handler that checks thread_ts after 5 minutes
  // const delayedCheck = setTimeout(async () => {
  //   const threadReplies = await client.conversations.replies({
  //     channel: event.channel,
  //     ts: event.ts,
  //   });
  //   if (threadReplies.messages.length === 1) {
  //     // Only the original message, no replies
  //     await offerHelp(client, event.channel, event.ts, event.text);
  //   }
  // }, 5 * 60 * 1000);
}

/**
 * Send a reply in a thread
 *
 * @param client - Slack client
 * @param channel - Channel ID
 * @param threadTs - Thread timestamp
 * @param blocks - Block Kit blocks to send
 */
async function sendThreadReply(
  client: any,
  channel: string,
  threadTs: string,
  ...blocks: any[]
): Promise<void> {
  try {
    // Would use: await client.chat.postMessage({
    //   channel,
    //   thread_ts: threadTs,
    //   blocks,
    // });
    console.log('Thread reply would be sent to:', { channel, threadTs, blocks });
  } catch (error) {
    console.error('Error sending thread reply:', error);
  }
}

/**
 * Get workspace context for Ask Kit
 * Includes projects, team, and workspace settings
 */
async function getWorkspaceContext(slackTeamId: string): Promise<any> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Fetch workspace by slack_team_id
  const { data: installation } = await supabase
.from('slack_oauth_installations')
    .select('workspace_id')
    .eq('slack_team_id', slackTeamId)
    .single();

  if (!installation) {
    return null;
  }

  // Fetch workspace data
  const { data: workspace } = await supabase
.from('workspaces')
    .select('*')
    .eq('id', installation.workspace_id)
    .single();

  // Fetch active projects
  const { data: projects } = await supabase
.from('projects')
    .select('*')
    .eq('workspace_id', installation.workspace_id)
    .in('status', ['in_progress', 'in_review', 'planning']);

  // Fetch team members
  const { data: team } = await supabase
.from('team_members')
    .select('*')
    .eq('workspace_id', installation.workspace_id)
    .eq('is_active', true);

  return {
    workspace,
    projects: projects || [],
    team: team || [],
  };
}

/**
 * Route question to Ask Kit (placeholder for Claude integration)
 * In production, this calls Claude with workspace context
 */
async function askKitQuestion(
  question: string,
  context: any
): Promise<{ answer: string; citations: Array<{ title: string; source: string }> }> {
  // Placeholder response structure
  return {
    answer:
      "This is where Kit's answer would go. In production, this calls Claude with workspace context.",
    citations: [
      {
        title: 'Project Dashboard',
        source: 'kit.example.com/projects',
      },
    ],
  };
}

/**
 * Build Block Kit response for Ask Kit answer
 */
function buildAskResponse(
  response: { answer: string; citations: any[] },
  question: string
): any[] {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Question:* ${question}`,
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: response.answer,
      },
    },
  ];

  if (response.citations && response.citations.length > 0) {
    const citationText = response.citations
      .map((c: any) => `• <${c.source}|${c.title}>`)
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Sources:*\n${citationText}`,
      },
    });
  }

  return blocks;
}

/**
 * Save conversation to history for context
 */
async function saveConversationHistory(
  slackTeamId: string,
  conversation: {
    channel_id: string;
    thread_ts: string;
    user_id: string;
    question: string;
    response: string;
    citations: any[];
    timestamp: Date;
  }
): Promise<void> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Get workspace_id
  const { data: installation } = await supabase
.from('slack_oauth_installations')
    .select('workspace_id')
    .eq('slack_team_id', slackTeamId)
    .single();

  if (!installation) return;

  // Save to conversation history table
await supabase.from('slack_conversations').insert({
    workspace_id: installation.workspace_id,
    channel_id: conversation.channel_id,
    thread_ts: conversation.thread_ts,
    user_id: conversation.user_id,
    question: conversation.question,
    response: conversation.response,
    citations: conversation.citations,
    created_at: conversation.timestamp,
  });
}
