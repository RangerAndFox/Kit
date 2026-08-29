// @ts-nocheck
/**
 * Slack /kit Slash Command Handler
 *
 * Parses and routes /kit subcommands:
 * - /kit status — workspace dashboard
 * - /kit ask [question] — routes to Ask Kit
 * - /kit budget [project] — project budget summary
 * - /kit newproject — opens project creation modal
 * - /kit help — command help text
 *
 * @module slack/commands
 */

import { getVoiceForSurface, buildPrompt } from '@/lib/agent/personality';
import type { Workspace } from '@/types/database';

// Type declarations for Slack Bolt
type SlackCommand = any;
type SlackContext = any;

/**
 * Main /kit command handler
 * Parses subcommand and delegates to appropriate handler
 *
 * @param payload - Slack command payload
 */
export async function handleKitCommand(payload: SlackCommand): Promise<void> {
  const { text, user_id, team_id, channel_id, trigger_id, context } = payload;

  // Parse subcommand: /kit [subcommand] [args...]
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() || 'help';
  const args = parts.slice(1);

  try {
    switch (subcommand) {
      case 'status':
        await handleStatusCommand(payload);
        break;
      case 'ask':
        await handleAskCommand(payload, args.join(' '));
        break;
      case 'budget':
        await handleBudgetCommand(payload, args[0]);
        break;
      case 'newproject':
        await handleNewProjectCommand(payload);
        break;
      case 'help':
      default:
        await handleHelpCommand(payload);
        break;
    }
  } catch (error) {
    console.error(`Error handling /kit ${subcommand}:`, error);
    // Send error message to user
    if (payload.respond) {
      payload.respond({
        response_type: 'ephemeral',
        text: `Sorry, I encountered an error processing that command. Please try again.`,
      });
    }
  }
}

/**
 * /kit status - Returns workspace dashboard summary
 *
 * Shows:
 * - Active projects count and status breakdown
 * - Pending actions count
 * - Today's priorities
 * - Budget health
 */
async function handleStatusCommand(payload: SlackCommand): Promise<void> {
  // Fetch workspace data
  const workspaceData = await fetchWorkspaceData(payload.team_id);

  if (!workspaceData) {
    if (payload.respond) {
      payload.respond({
        response_type: 'ephemeral',
        text: 'Could not find workspace data. Is Kit installed for this workspace?',
      });
    }
    return;
  }

  const { workspace, projects, actions, personality } = workspaceData;

  // Count projects by status
  const statusCounts = {
    in_progress: projects.filter((p: any) => p.status === 'in_progress').length,
    in_review: projects.filter((p: any) => p.status === 'in_review').length,
    planning: projects.filter((p: any) => p.status === 'planning').length,
    at_risk: projects.filter((p: any) => p.status === 'on_hold').length,
  };

  // Build response blocks using personality
  const blocks = buildWorkspaceStatusBlocks(
    workspace,
    projects,
    statusCounts,
    actions,
    personality
  );

  if (payload.respond) {
    payload.respond({
      response_type: 'in_channel',
      blocks,
    });
  }
}

/**
 * /kit ask [question] - Routes to Ask Kit
 *
 * Takes a user question and:
 * 1. Sends to Claude with Kit's context
 * 2. Returns response with citations
 * 3. Saves to conversation history
 */
async function handleAskCommand(
  payload: SlackCommand,
  question: string
): Promise<void> {
  if (!question.trim()) {
    if (payload.respond) {
      payload.respond({
        response_type: 'ephemeral',
        text: 'Please provide a question. Example: `/kit ask What projects are due this week?`',
      });
    }
    return;
  }

  const workspaceData = await fetchWorkspaceData(payload.team_id);
  if (!workspaceData) {
    if (payload.respond) {
      payload.respond({
        response_type: 'ephemeral',
        text: 'Could not access workspace context.',
      });
    }
    return;
  }

  // Here we would call Claude with the Ask Kit module
  // For now, structure the response
  const { workspace, projects, personality } = workspaceData;

  const systemPrompt = buildPrompt(workspace, "You are Kit. Answer the user's question about this workspace using available context.", 'notification');

  // Response blocks
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_Processing: "${question}"_\n\n_Using workspace context: ${projects.length} projects, ${workspace.name}_`,
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*(Claude response would appear here)*\n\nIn production, this routes to Claude with workspace context.',
      },
    },
  ];

  if (payload.respond) {
    payload.respond({
      response_type: 'in_channel',
      blocks,
    });
  }
}

/**
 * /kit budget [project] - Returns project budget summary
 *
 * Shows:
 * - Total budget and spent
 * - Percentage used
 * - Remaining allocation
 * - Cost breakdown by category
 */
async function handleBudgetCommand(
  payload: SlackCommand,
  projectId?: string
): Promise<void> {
  const workspaceData = await fetchWorkspaceData(payload.team_id);
  if (!workspaceData) {
    if (payload.respond) {
      payload.respond({
        response_type: 'ephemeral',
        text: 'Could not access workspace context.',
      });
    }
    return;
  }

  const { projects } = workspaceData;

  // Get project or show all
  let targetProjects = projects;
  if (projectId) {
    targetProjects = projects.filter(
      (p: any) => p.id === projectId || p.slug === projectId
    );
    if (targetProjects.length === 0) {
      if (payload.respond) {
        payload.respond({
          response_type: 'ephemeral',
          text: `Project "${projectId}" not found.`,
        });
      }
      return;
    }
  }

  const blocks = buildBudgetSummaryBlocks(targetProjects);

  if (payload.respond) {
    payload.respond({
      response_type: 'in_channel',
      blocks,
    });
  }
}

/**
 * /kit newproject - Opens project creation modal
 *
 * Triggers a modal with fields:
 * - Project name
 * - Client name
 * - Budget
 * - Start/end dates
 * - Team assignment
 */
async function handleNewProjectCommand(payload: SlackCommand): Promise<void> {
  const { trigger_id } = payload;

  const modal = {
    type: 'modal',
    callback_id: 'new_project_modal',
    title: {
      type: 'plain_text',
      text: 'New Project',
    },
    submit: {
      type: 'plain_text',
      text: 'Create',
    },
    blocks: [
      {
        type: 'input',
        block_id: 'project_name',
        label: {
          type: 'plain_text',
          text: 'Project Name',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'name_input',
          placeholder: {
            type: 'plain_text',
            text: 'e.g., Nike Campaign',
          },
        },
        required: true,
      },
      {
        type: 'input',
        block_id: 'client_name',
        label: {
          type: 'plain_text',
          text: 'Client Name',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'client_input',
          placeholder: {
            type: 'plain_text',
            text: 'e.g., Nike',
          },
        },
      },
      {
        type: 'input',
        block_id: 'budget',
        label: {
          type: 'plain_text',
          text: 'Budget',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'budget_input',
          placeholder: {
            type: 'plain_text',
            text: 'e.g., 50000',
          },
        },
      },
      {
        type: 'input',
        block_id: 'deadline',
        label: {
          type: 'plain_text',
          text: 'Deadline',
        },
        element: {
          type: 'datepicker',
          action_id: 'deadline_picker',
        },
      },
    ],
  };

  // This would use payload.client.views.open(trigger_id, modal)
  // For now, just logging the structure
  console.log('New project modal would open with trigger_id:', trigger_id);
}

/**
 * /kit help - Returns help text with available commands
 */
async function handleHelpCommand(payload: SlackCommand): Promise<void> {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Kit Commands',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*`/kit status`*\nSee your workspace dashboard and active projects',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*`/kit ask [question]`*\nAsk Kit about your projects, timeline, or team\nExample: `/kit ask What\'s due this week?`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*`/kit budget [project]`*\nCheck project budget and spending\nExample: `/kit budget Nike`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*`/kit newproject`*\nCreate a new project in Kit',
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'You can also *mention @Kit* in any channel with a question, and Kit will respond in thread.',
      },
    },
  ];

  if (payload.respond) {
    payload.respond({
      response_type: 'ephemeral',
      blocks,
    });
  }
}

/**
 * Fetch workspace data for Slack team
 * Includes workspace, projects, personality config, and pending actions
 */
async function fetchWorkspaceData(
  slackTeamId: string
): Promise<{
  workspace: Workspace;
  projects: any[];
  actions: any[];
  personality: any;
} | null> {
  // This would fetch from Supabase
  // For now, return null to indicate the structure
  return null;
}

/**
 * Build Block Kit blocks for workspace status
 */
function buildWorkspaceStatusBlocks(
  workspace: Workspace,
  projects: any[],
  statusCounts: Record<string, number>,
  actions: any[],
  personality: any
): any[] {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${workspace.name} Dashboard`,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*In Progress*\n${statusCounts.in_progress} projects`,
        },
        {
          type: 'mrkdwn',
          text: `*In Review*\n${statusCounts.in_review} projects`,
        },
        {
          type: 'mrkdwn',
          text: `*Planning*\n${statusCounts.planning} projects`,
        },
        {
          type: 'mrkdwn',
          text: `*At Risk*\n${statusCounts.at_risk} projects`,
        },
      ],
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Pending Actions*\n${actions.length} awaiting decision`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View Dashboard',
          },
          url: `${process.env.NEXT_PUBLIC_APP_URL}/control-center`,
        },
      ],
    },
  ];
}

/**
 * Build Block Kit blocks for budget summary
 */
function buildBudgetSummaryBlocks(projects: any[]): any[] {
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Budget Summary',
      },
    },
  ];

  projects.forEach((project) => {
    const spent = project.spent || 0;
    const budget = project.budget || 0;
    const percentage = budget > 0 ? Math.round((spent / budget) * 100) : 0;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${project.name}*\n$${spent.toLocaleString()} / $${budget.toLocaleString()} (${percentage}%)`,
      },
    });
  });

  return blocks;
}
