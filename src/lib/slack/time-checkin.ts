/**
 * Daily Time Tracking via Slack
 *
 * Sends 5PM daily check-in DMs asking how time was spent,
 * with interactive buttons for projects and time increments.
 *
 * @module slack/time-checkin
 */

import { createClient } from '@supabase/supabase-js';

// Type declarations
type SlackClient = any;
type SlackInteractionPayload = any;

/**
 * Send daily 5PM check-in DM to team member
 *
 * DM structure:
 * - "How did you spend your time today?"
 * - Assigned projects (buttons)
 * - Time increment buttons (0.5, 1, 2, 4, 8 hours)
 * - Quick categories (Design, Animation, Comp, Review, Admin)
 *
 * @param workspaceId - Kit workspace ID
 * @param userId - Slack user ID
 * @param slackClient - Slack client for sending messages
 * @param userProjects - Array of projects assigned to user
 */
export async function sendDailyCheckin(
  workspaceId: string,
  userId: string,
  slackClient: SlackClient,
  userProjects: Array<{ id: string; name: string }>
): Promise<void> {
  try {
    // Build greeting
    const now = new Date();
    const hour = now.getHours();
    const greeting =
      hour < 12
        ? 'Good morning'
        : hour < 17
          ? 'Good afternoon'
          : 'Good evening';

    // Build blocks
    const blocks = buildDailyCheckinBlocks(userProjects);

    // Send DM
    const result = await slackClient.conversations.open({
      users: userId,
    });

    await slackClient.chat.postMessage({
      channel: result.channel.id,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${greeting}! How did you spend your time today?`,
          },
        },
        {
          type: 'divider',
        },
        ...blocks,
      ],
    });
  } catch (error) {
    console.error('Error sending daily check-in:', error);
  }
}

/**
 * Handle check-in response from interactive buttons
 *
 * Processes payload containing:
 * - Selected project
 * - Selected time duration
 * - Optional category
 *
 * Saves TimeEntry to database
 *
 * @param payload - Slack interaction payload
 */
export async function handleCheckinResponse(
  payload: SlackInteractionPayload
): Promise<void> {
  const { user, team, actions, trigger_id } = payload;

  try {
    // Parse action data
    const projectAction = actions.find((a: any) =>
      a.action_id.startsWith('checkin_project_')
    );
    const durationAction = actions.find((a: any) =>
      a.action_id.startsWith('checkin_duration_')
    );
    const categoryAction = actions.find((a: any) =>
      a.action_id.startsWith('checkin_category_')
    );

    if (!projectAction || !durationAction) {
      console.warn('Missing required check-in data');
      return;
    }

    // Extract values from action IDs
    const projectId = projectAction.action_id.replace('checkin_project_', '');
    const durationHours = parseFloat(
      durationAction.action_id.replace('checkin_duration_', '')
    );
    const category = categoryAction
      ? categoryAction.action_id.replace('checkin_category_', '')
      : null;

    // Save to database
    await saveTimeEntry(team.id, user.id, projectId, durationHours, category);

    // Send confirmation
    // Would use payload.client.chat.postEphemeral to send confirmation
    console.log('Time entry saved:', {
      projectId,
      durationHours,
      category,
      date: new Date().toISOString().split('T')[0],
    });
  } catch (error) {
    console.error('Error handling check-in response:', error);
  }
}

/**
 * Build Block Kit blocks for daily check-in
 *
 * @param projects - Array of projects assigned to user
 * @returns Array of Block Kit blocks
 */
function buildDailyCheckinBlocks(
  projects: Array<{ id: string; name: string }>
): any[] {
  const blocks: any[] = [];

  // Project selection
  if (projects.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Which project did you work on?*',
      },
    });

    blocks.push({
      type: 'actions',
      elements: projects.map((project) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: project.name,
          emoji: true,
        },
        value: project.id,
        action_id: `checkin_project_${project.id}`,
      })),
    });
  }

  // Time duration selection
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*How many hours?*',
    },
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '0.5 hr',
        },
        value: '0.5',
        action_id: 'checkin_duration_0.5',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '1 hr',
        },
        value: '1',
        action_id: 'checkin_duration_1',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '2 hrs',
        },
        value: '2',
        action_id: 'checkin_duration_2',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '4 hrs',
        },
        value: '4',
        action_id: 'checkin_duration_4',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '8 hrs',
        },
        value: '8',
        action_id: 'checkin_duration_8',
      },
    ],
  });

  // Work category
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*What type of work?* (optional)',
    },
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Design',
        },
        value: 'design',
        action_id: 'checkin_category_design',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Animation',
        },
        value: 'animation',
        action_id: 'checkin_category_animation',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Compositing',
        },
        value: 'comp',
        action_id: 'checkin_category_comp',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Review',
        },
        value: 'review',
        action_id: 'checkin_category_review',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Admin',
        },
        value: 'admin',
        action_id: 'checkin_category_admin',
      },
    ],
  });

  return blocks;
}

/**
 * Save time entry to database
 */
async function saveTimeEntry(
  slackTeamId: string,
  slackUserId: string,
  projectId: string,
  durationHours: number,
  category: string | null
): Promise<void> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Get workspace and team member
  const { data: installation } = await supabase
.from('slack_oauth_installations')
    .select('workspace_id')
    .eq('slack_team_id', slackTeamId)
    .single();

  if (!installation) return;

  // Get team member by slack_user_id
  const { data: teamMember } = await supabase
.from('team_members')
    .select('id')
    .eq('workspace_id', installation.workspace_id)
    .eq('slack_user_id', slackUserId)
    .single();

  if (!teamMember) return;

  // Map category to TimeEntryCategory
  const categoryMap: Record<string, string> = {
    design: 'production',
    animation: 'production',
    comp: 'production',
    review: 'review',
    admin: 'admin',
  };

  const timeEntryCategory = category ? categoryMap[category] || 'production' : 'production';

  // Save time entry
await supabase.from('time_entries').insert({
    workspace_id: installation.workspace_id,
    team_member_id: teamMember.id,
    project_id: projectId,
    duration_minutes: Math.round(durationHours * 60),
    category: timeEntryCategory,
    date: new Date().toISOString().split('T')[0],
    billable: true,
  });
}
