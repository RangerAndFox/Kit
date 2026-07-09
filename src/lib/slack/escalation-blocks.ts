/**
 * Slack Permission Escalation Blocks
 *
 * Handles permission requests that require founder approval.
 * Used when team members request access to sensitive information
 * like budget details or client contracts.
 *
 * @module slack/escalation-blocks
 */

import { createClient } from '@supabase/supabase-js';

// Type declarations
type SlackClient = any;
type SlackInteractionPayload = any;

/**
 * Handle escalation decision action
 *
 * Processes founder's decision on permission request:
 * - Grant for project
 * - Grant for all
 * - Deny
 * - Respond with custom message
 *
 * @param payload - Slack interaction payload
 */
export async function handleEscalationAction(
  payload: SlackInteractionPayload
): Promise<void> {
  const { actions, team_id, user, trigger_id, client } = payload;

  try {
    const action = actions[0];
    const actionId = action.action_id;

    if (actionId === 'escalation_grant_project') {
      await grantProjectAccess(payload);
    } else if (actionId === 'escalation_grant_all') {
      await grantFullAccess(payload);
    } else if (actionId === 'escalation_deny') {
      await denyRequest(payload);
    } else if (actionId === 'escalation_respond') {
      await openResponseModal(trigger_id, client, payload);
    }
  } catch (error) {
    console.error('Error handling escalation action:', error);
  }
}

/**
 * Grant access for specific project
 */
async function grantProjectAccess(payload: SlackInteractionPayload): Promise<void> {
  const { team_id, user, actions } = payload;
  const actionId = actions[0].action_id;
  const projectId = actionId.split('_').pop();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Get workspace
  const { data: installation } = await supabase
    .from('slack_oauth_installations' as any)
    .select('workspace_id')
    .eq('slack_team_id', team_id)
    .single();

  if (!installation) return;

  // Extract requester ID from payload metadata
  // This would be passed in the initial request
  const requesterId = payload.metadata?.requester_id;

  if (requesterId && projectId) {
    // Update permission_requests table
    await supabase.from('permission_requests' as any).insert({
      workspace_id: installation.workspace_id,
      requester_id: requesterId,
      resource_type: 'project',
      resource_id: projectId,
      status: 'granted',
      decision_maker_id: user.id,
      decided_at: new Date().toISOString(),
    });
  }
}

/**
 * Grant access for all projects
 */
async function grantFullAccess(payload: SlackInteractionPayload): Promise<void> {
  const { team_id, user } = payload;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Get workspace
  const { data: installation } = await supabase
    .from('slack_oauth_installations' as any)
    .select('workspace_id')
    .eq('slack_team_id', team_id)
    .single();

  if (!installation) return;

  const requesterId = payload.metadata?.requester_id;

  if (requesterId) {
    await supabase.from('permission_requests' as any).insert({
      workspace_id: installation.workspace_id,
      requester_id: requesterId,
      resource_type: 'all',
      resource_id: null,
      status: 'granted',
      decision_maker_id: user.id,
      decided_at: new Date().toISOString(),
    });
  }
}

/**
 * Deny access request
 */
async function denyRequest(payload: SlackInteractionPayload): Promise<void> {
  const { team_id, user } = payload;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Get workspace
  const { data: installation } = await supabase
    .from('slack_oauth_installations' as any)
    .select('workspace_id')
    .eq('slack_team_id', team_id)
    .single();

  if (!installation) return;

  const requesterId = payload.metadata?.requester_id;

  if (requesterId) {
    await supabase.from('permission_requests' as any).insert({
      workspace_id: installation.workspace_id,
      requester_id: requesterId,
      resource_type: 'metadata',
      resource_id: null,
      status: 'denied',
      decision_maker_id: user.id,
      decided_at: new Date().toISOString(),
    });
  }
}

/**
 * Open modal for founder to provide custom response
 */
async function openResponseModal(
  triggerId: string,
  client: SlackClient,
  payload: SlackInteractionPayload
): Promise<void> {
  const modal = {
    type: 'modal',
    callback_id: 'escalation_response_modal',
    title: {
      type: 'plain_text',
      text: 'Send Response',
    },
    submit: {
      type: 'plain_text',
      text: 'Send',
    },
    blocks: [
      {
        type: 'input',
        block_id: 'response_message',
        label: {
          type: 'plain_text',
          text: 'Your message',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'message_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Explain your decision or next steps...',
          },
        },
      },
    ],
  };

  // Would use: await client.views.open({ trigger_id: triggerId, view: modal })
  console.log('Response modal would open:', { triggerId, modal });
}
