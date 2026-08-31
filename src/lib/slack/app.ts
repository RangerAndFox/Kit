/**
 * Slack Bolt App Initialization
 *
 * This module initializes a multi-workspace Slack app with OAuth support.
 * It handles token management through Supabase, registers command and event handlers,
 * and provides the configured Bolt app instance.
 *
 * @module slack/app
 */

import { createClient } from '@supabase/supabase-js';

// Type declarations for Slack Bolt (installed at deployment)
type SlackApp = any; // @slack/bolt App
type SlackContext = any; // @slack/bolt Context

/**
 * Slack OAuth configuration structure
 * Stores workspace-specific tokens and configuration
 */
interface SlackOAuthConfig {
  workspace_id: string;
  slack_team_id: string;
  slack_team_name: string;
  slack_bot_token: string;
  slack_bot_id: string;
  slack_app_id: string;
  slack_signing_secret: string;
  installed_at: Date;
  scopes: string[];
}

/**
 * Custom OAuth installation store for Supabase
 * Implements Slack Bolt's InstallationStore interface
 */
class SupabaseInstallationStore {
  private supabase: any;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Save OAuth installation data
   * Called when app is installed in a new workspace
   */
  async saveInstallation(installation: any): Promise<void> {
    const {
      team: { id: slackTeamId, name: slackTeamName },
      bot_token: slackBotToken,
      bot_id: slackBotId,
      app_id: slackAppId,
      enterprise: { id: enterpriseId } = {},
    } = installation;

    const { error } = await this.supabase
.from('slack_oauth_installations')
      .upsert(
        {
          slack_team_id: slackTeamId,
          slack_team_name: slackTeamName,
          slack_bot_token: slackBotToken,
          slack_bot_id: slackBotId,
          slack_app_id: slackAppId,
          enterprise_id: enterpriseId || null,
          is_enterprise_install: !slackTeamId,
          installed_at: new Date().toISOString(),
          raw_installation_data: JSON.stringify(installation),
        },
        { onConflict: 'slack_team_id' }
      );

    if (error) {
      throw new Error(`Failed to save Slack installation: ${error.message}`);
    }
  }

  /**
   * Retrieve OAuth installation for a workspace
   */
  async fetchInstallation(args: {
    teamId?: string;
    enterpriseId?: string;
    userId?: string;
  }): Promise<any> {
    const { teamId, enterpriseId } = args;

    const query = this.supabase
.from('slack_oauth_installations')
      .select('raw_installation_data');

    if (teamId) {
      query.eq('slack_team_id', teamId);
    }
    if (enterpriseId) {
      query.eq('enterprise_id', enterpriseId);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return undefined;
    }

    return JSON.parse(data.raw_installation_data);
  }

  /**
   * Delete installation (e.g., when app is uninstalled)
   */
  async deleteInstallation(args: {
    teamId?: string;
    enterpriseId?: string;
  }): Promise<void> {
    const { teamId, enterpriseId } = args;

    let query = this.supabase
.from('slack_oauth_installations')
      .delete();

    if (teamId) {
      query = query.eq('slack_team_id', teamId);
    }
    if (enterpriseId) {
      query = query.eq('enterprise_id', enterpriseId);
    }

    const { error } = await query;

    if (error) {
      throw new Error(`Failed to delete Slack installation: ${error.message}`);
    }
  }
}

/**
 * Creates and configures the Slack Bolt app
 *
 * Initializes:
 * - OAuth installation store with Supabase
 * - All command handlers (/kit subcommands)
 * - Event listeners (mentions, questions, etc.)
 * - Interaction handlers (buttons, modals)
 *
 * @param config - Configuration object containing API tokens and workspace settings
 * @returns Configured Slack Bolt app instance
 */
export async function createSlackApp(config: {
  slackSigningSecret: string;
  slackBotToken?: string; // Optional if using OAuth
  supabaseUrl: string;
  supabaseKey: string;
}): Promise<SlackApp> {
  // Note: In production, @slack/bolt App would be imported and used
  // For now, this is typed as `any` since the package isn't installed

  const installationStore = new SupabaseInstallationStore(
    config.supabaseUrl,
    config.supabaseKey
  );

  // Create Bolt app with OAuth and token verification
  // This would use: new App({ signingSecret, installationStore })
  const app: SlackApp = {
    // Placeholder app instance
    // In production: const app = new App({ signingSecret: config.slackSigningSecret, installationStore })
    _initialized: true,
  };

  // Register command handlers
  // /kit status, /kit ask, /kit budget, /kit newproject, /kit help
  if (app.command) {
    app.command('/kit', async (payload: any) => {
      const { handleKitCommand } = await import('./commands');
      return handleKitCommand(payload);
    });
  }

  // Register event listeners
  if (app.event) {
    // @mention events (someone mentions Kit in a channel)
    app.event('app_mention', async (payload: any) => {
      const { handleAppMention } = await import('./events');
      return handleAppMention(payload);
    });

    // Message events (detect unanswered questions)
    app.event('message', async (payload: any) => {
      const { handleMessageEvent } = await import('./events');
      return handleMessageEvent(payload);
    });
  }

  // Register interaction handlers
  if (app.action) {
    // Time checkin responses
    app.action(/checkin_project_.*/, async (payload: any) => {
      const { handleCheckinResponse } = await import('./time-checkin');
      return handleCheckinResponse(payload);
    });

    // Escalation decisions
    app.action(/escalation_.*/, async (payload: any) => {
      const { handleEscalationAction } = await import('./escalation-blocks');
      return handleEscalationAction(payload);
    });

    // Task card actions
    app.action(/taskcard_.*/, async (payload: any) => {
      const { handleTaskCardAction } = await import('./task-card-blocks');
      return handleTaskCardAction(payload);
    });
  }

  return app;
}

/**
 * Get OAuth installation for a specific workspace
 * Used to retrieve bot tokens for API calls
 */
export async function getWorkspaceSlackConfig(
  supabaseUrl: string,
  supabaseKey: string,
  slackTeamId: string
): Promise<SlackOAuthConfig | null> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
.from('slack_oauth_installations')
    .select('*')
    .eq('slack_team_id', slackTeamId)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    workspace_id: data.workspace_id,
    slack_team_id: data.slack_team_id,
    slack_team_name: data.slack_team_name,
    slack_bot_token: data.slack_bot_token,
    slack_bot_id: data.slack_bot_id,
    slack_app_id: data.slack_app_id,
    slack_signing_secret: data.slack_signing_secret,
    installed_at: new Date(data.installed_at),
    scopes: data.scopes || [],
  };
}

/**
 * Extract workspace ID from Slack team ID
 * Maps Slack's team ID to Kit's workspace ID in database
 */
export async function getKitWorkspaceBySlackTeam(
  supabaseUrl: string,
  supabaseKey: string,
  slackTeamId: string
): Promise<any> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
.from('slack_oauth_installations')
    .select('workspace_id')
    .eq('slack_team_id', slackTeamId)
    .single();

  if (error || !data) {
    return null;
  }

  // Now fetch the workspace from Kit's workspace table
  const { data: workspace } = await supabase
.from('workspaces')
    .select('*')
    .eq('id', data.workspace_id)
    .single();

  return workspace;
}
