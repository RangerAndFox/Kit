// @ts-nocheck
/**
 * Agent sweep system for periodic health checks
 * Monitors budget, schedule, and feedback across projects
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { AgentRun, KitAction } from '@/types/database';

export interface SweepCheckResult {
  actionsCreated: string[];
  issuesFound: number;
}

/** Statuses that mean "this action is still in front of a human". */
const OPEN_ACTION_STATUSES = ['suggested', 'pending', 'approved'];

/**
 * Insert a sweep action only when no OPEN action already exists for the same
 * ongoing condition — without this, every sweep run re-suggested identical
 * "over budget" / "milestone overdue" / "stale feedback" actions, producing a
 * growing pile per day the condition persisted.
 *
 * Identity = (project_id, type) plus optional payload markers (e.g.
 * milestone_id, alert_kind) so distinct conditions of the same type on one
 * project still each get their own action. Returns the new action id, or
 * null when suppressed / on failure.
 */
async function insertActionOnce(
  admin: any,
  row: Record<string, any>,
  payloadIdentity: Record<string, string | number> = {}
): Promise<string | null> {
  let q = admin
    .from('kit_actions' as any)
    .select('id')
    .eq('project_id', row.project_id)
    .eq('type', row.type)
    .in('status', OPEN_ACTION_STATUSES)
    .limit(1);
  for (const [field, value] of Object.entries(payloadIdentity)) {
    q = q.eq(`payload->>${field}`, String(value));
  }
  const { data: existing } = await q;
  if (existing && existing.length > 0) return null;

  const { data: action, error } = await admin
    .from('kit_actions' as any)
    .insert(row)
    .select('id')
    .single();
  if (error || !action) {
    if (error) console.error(`Failed to insert ${row.type} action:`, error);
    return null;
  }
  return (action as any).id;
}

/**
 * Run a complete agent sweep for a workspace
 * Creates an agent_run record and executes all health checks
 */
export async function runAgentSweep(workspaceId: string): Promise<AgentRun> {
  const admin = createAdminClient();
  const startTime = Date.now();

  // Create agent run record
  const { data: runRecord, error: runError } = await admin
    .from('agent_runs' as any)
    .insert({
      workspace_id: workspaceId,
      triggered_by: 'scheduled',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (runError || !runRecord) {
    throw new Error(`Failed to create agent run: ${runError?.message}`);
  }

  const agentRunId = (runRecord as any).id;
  const allActionIds: string[] = [];

  try {
    // Run all health checks
    const budgetResult = await checkBudgetHealth(workspaceId, agentRunId);
    allActionIds.push(...budgetResult.actionsCreated);

    const scheduleResult = await checkScheduleHealth(workspaceId, agentRunId);
    allActionIds.push(...scheduleResult.actionsCreated);

    const feedbackResult = await checkFeedbackHealth(workspaceId, agentRunId);
    allActionIds.push(...feedbackResult.actionsCreated);

    // Update agent run with completion status
    const { error: updateError } = await admin
      .from('agent_runs' as any)
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        actions: allActionIds,
        summary: `Sweep completed: ${allActionIds.length} actions created`,
      })
      .eq('id', agentRunId);

    if (updateError) {
      console.error('Failed to update agent run:', updateError);
    }

    return {
      id: agentRunId,
      workspace_id: workspaceId,
      triggered_by: 'scheduled',
      status: 'completed',
      actions: allActionIds,
      duration_ms: Date.now() - startTime,
      summary: `Sweep completed: ${allActionIds.length} actions created`,
      started_at: new Date(),
      completed_at: new Date(),
    };
  } catch (error) {
    // Update agent run with error status
    await admin
      .from('agent_runs' as any)
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      .eq('id', agentRunId);

    throw error;
  }
}

/**
 * Check budget health across all projects in a workspace
 * Identifies projects trending over budget or with concerning spend patterns
 */
export async function checkBudgetHealth(
  workspaceId: string,
  agentRunId: string
): Promise<SweepCheckResult> {
  const admin = createAdminClient();
  const actionsCreated: string[] = [];

  // Get all projects with budgets
  const { data: projects, error: projectsError } = await admin
    .from('projects' as any)
    .select('id, name, budget, start_date, end_date')
    .eq('workspace_id', workspaceId)
    .not('budget', 'is', null);

  if (projectsError) {
    console.error('Failed to fetch projects for budget check:', projectsError);
    return { actionsCreated, issuesFound: 0 };
  }

  if (!projects || projects.length === 0) {
    return { actionsCreated, issuesFound: 0 };
  }

  // For each project, check spend vs budget
  for (const project of projects) {
    // Get total time entries cost
    const { data: timeEntries, error: timeError } = await admin
      .from('time_entries' as any)
      .select('duration_minutes, rate_per_hour')
      .eq('project_id', project.id);

    if (timeError) {
      console.error(`Failed to fetch time entries for project ${project.id}:`, timeError);
      continue;
    }

    let totalSpend = 0;
    if (timeEntries) {
      totalSpend = timeEntries.reduce((sum, entry) => {
        const hours = entry.duration_minutes / 60;
        const cost = hours * (entry.rate_per_hour || 0);
        return sum + cost;
      }, 0);
    }

    const budget = project.budget || 0;
    const percentUsed = budget > 0 ? (totalSpend / budget) * 100 : 0;
    const timelineProgress = calculateTimelineProgress(project.start_date, project.end_date);

    // Alert if spend is disproportionate to timeline progress
    // E.g., 80% through timeline but 50% of budget, or 50% through timeline but 80% of budget
    const imbalance = Math.abs(percentUsed - timelineProgress);

    if (percentUsed > 100) {
      // Project is over budget
      const priority = percentUsed > 150 ? 'critical' : percentUsed > 125 ? 'high' : 'medium';

      const id = await insertActionOnce(
        admin,
        {
          workspace_id: workspaceId,
          project_id: project.id,
          agent_run_id: agentRunId,
          type: 'budget_alert',
          status: 'suggested',
          title: `Project over budget: ${percentUsed.toFixed(0)}% used`,
          description: `${project.name} has spent $${totalSpend.toFixed(2)} of $${budget}. Review spend and adjust timeline or scope.`,
          payload: {
            alert_kind: 'over_budget',
            budget,
            spent: totalSpend,
            percent_used: percentUsed,
            timeline_progress: timelineProgress,
          },
          confidence_score: 0.95,
          reasoning: `Budget tracking: ${percentUsed.toFixed(0)}% of budget used`,
        },
        { alert_kind: 'over_budget' }
      );
      if (id) actionsCreated.push(id);
    } else if (imbalance > 30 && percentUsed < timelineProgress) {
      // Positive: under-spending relative to timeline
      const id = await insertActionOnce(
        admin,
        {
          workspace_id: workspaceId,
          project_id: project.id,
          agent_run_id: agentRunId,
          type: 'budget_alert',
          status: 'suggested',
          title: `Project tracking under budget`,
          description: `${project.name} is ${timelineProgress.toFixed(0)}% through timeline but only ${percentUsed.toFixed(0)}% through budget. Review if quality or scope is being compromised.`,
          payload: {
            alert_kind: 'under_budget',
            budget,
            spent: totalSpend,
            percent_used: percentUsed,
            timeline_progress: timelineProgress,
          },
          confidence_score: 0.8,
          reasoning: `Budget tracking: positive variance detected`,
        },
        { alert_kind: 'under_budget' }
      );
      if (id) actionsCreated.push(id);
    }
  }

  return {
    actionsCreated,
    issuesFound: actionsCreated.length,
  };
}

/**
 * Check schedule health across all projects
 * Identifies overdue milestones and upcoming deadlines
 */
export async function checkScheduleHealth(
  workspaceId: string,
  agentRunId: string
): Promise<SweepCheckResult> {
  const admin = createAdminClient();
  const actionsCreated: string[] = [];
  const now = new Date();
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  // Get all milestones
  const { data: milestones, error: milestonesError } = await admin
    .from('milestones' as any)
    .select('id, name, project_id, due_date, status, progress_percentage')
    .eq('workspace_id', workspaceId);

  if (milestonesError) {
    console.error('Failed to fetch milestones for schedule check:', milestonesError);
    return { actionsCreated, issuesFound: 0 };
  }

  if (!milestones || milestones.length === 0) {
    return { actionsCreated, issuesFound: 0 };
  }

  for (const milestone of milestones) {
    const dueDate = new Date(milestone.due_date);

    // Check if overdue
    if (dueDate < now && milestone.status !== 'completed') {
      const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000));

      const id = await insertActionOnce(
        admin,
        {
          workspace_id: workspaceId,
          project_id: milestone.project_id,
          agent_run_id: agentRunId,
          type: 'schedule_alert',
          status: 'suggested',
          title: `Milestone overdue: ${milestone.name}`,
          description: `${milestone.name} was due ${daysOverdue} days ago and is still ${milestone.status}. Current progress: ${milestone.progress_percentage}%. Follow up to understand blockers.`,
          payload: {
            alert_kind: 'overdue',
            milestone_id: milestone.id,
            days_overdue: daysOverdue,
            progress_percentage: milestone.progress_percentage,
            current_status: milestone.status,
          },
          confidence_score: 1.0,
          reasoning: `Schedule tracking: milestone is ${daysOverdue} days overdue`,
        },
        // Per-milestone identity: another overdue milestone on the same
        // project must still alert; the SAME milestone must not re-alert
        // every sweep while it stays overdue.
        { milestone_id: milestone.id, alert_kind: 'overdue' }
      );
      if (id) actionsCreated.push(id);
    }
    // Check if due within 3 days (upcoming)
    else if (dueDate > now && dueDate <= threeDaysFromNow && milestone.status !== 'completed') {
      const daysUntil = Math.ceil((dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      const id = await insertActionOnce(
        admin,
        {
          workspace_id: workspaceId,
          project_id: milestone.project_id,
          agent_run_id: agentRunId,
          type: 'schedule_alert',
          status: 'suggested',
          title: `Upcoming milestone: ${milestone.name}`,
          description: `${milestone.name} is due in ${daysUntil} days. Current progress: ${milestone.progress_percentage}%. Ensure team is on track.`,
          payload: {
            alert_kind: 'upcoming',
            milestone_id: milestone.id,
            days_until: daysUntil,
            progress_percentage: milestone.progress_percentage,
            current_status: milestone.status,
          },
          confidence_score: 0.9,
          reasoning: `Schedule tracking: milestone due in ${daysUntil} days`,
        },
        { milestone_id: milestone.id, alert_kind: 'upcoming' }
      );
      if (id) actionsCreated.push(id);
    }
  }

  return {
    actionsCreated,
    issuesFound: actionsCreated.length,
  };
}

/**
 * Check feedback health across all projects
 * Identifies stale unresolved feedback (>48h) that needs attention
 */
export async function checkFeedbackHealth(
  workspaceId: string,
  agentRunId: string
): Promise<SweepCheckResult> {
  const admin = createAdminClient();
  const actionsCreated: string[] = [];
  const now = new Date();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // Get all unresolved feedback older than 48 hours
  const { data: feedback, error: feedbackError } = await admin
    .from('feedback_items' as any)
    .select(
      `
      id,
      project_id,
      deliverable_id,
      content,
      priority,
      status,
      created_at,
      assigned_to_id
    `
    )
    .eq('workspace_id', workspaceId)
    .in('status', ['open', 'addressed'])
    .lt('created_at', fortyEightHoursAgo.toISOString());

  if (feedbackError) {
    console.error('Failed to fetch feedback for health check:', feedbackError);
    return { actionsCreated, issuesFound: 0 };
  }

  if (!feedback || feedback.length === 0) {
    return { actionsCreated, issuesFound: 0 };
  }

  // Group feedback by project and priority
  const feedbackByProject: Record<string, any[]> = {};

  for (const item of feedback) {
    if (!feedbackByProject[item.project_id]) {
      feedbackByProject[item.project_id] = [];
    }
    feedbackByProject[item.project_id].push(item);
  }

  // Create actions for stale feedback
  for (const [projectId, projectFeedback] of Object.entries(feedbackByProject)) {
    const criticalCount = projectFeedback.filter((f) => f.priority === 'critical').length;
    const highCount = projectFeedback.filter((f) => f.priority === 'high').length;

    if (criticalCount > 0) {
      const id = await insertActionOnce(admin, {
        workspace_id: workspaceId,
        project_id: projectId,
        agent_run_id: agentRunId,
        type: 'feedback_summary',
        status: 'suggested',
        title: `${criticalCount} critical feedback items stale (>48h)`,
        description: `Project has ${criticalCount} critical feedback items unresolved for >48 hours. Immediate action needed to unblock progress.`,
        payload: {
          stale_feedback_count: projectFeedback.length,
          critical_count: criticalCount,
          high_count: highCount,
          feedback_ids: projectFeedback.map((f) => f.id),
        },
        confidence_score: 1.0,
        reasoning: `Feedback tracking: ${criticalCount} critical items stale`,
      });
      if (id) actionsCreated.push(id);
    } else if (highCount > 0) {
      const id = await insertActionOnce(admin, {
        workspace_id: workspaceId,
        project_id: projectId,
        agent_run_id: agentRunId,
        type: 'feedback_summary',
        status: 'suggested',
        title: `${highCount} high-priority feedback items stale`,
        description: `Project has ${highCount} high-priority feedback items unresolved for >48 hours. Review and prioritize addressing.`,
        payload: {
          stale_feedback_count: projectFeedback.length,
          high_count: highCount,
          feedback_ids: projectFeedback.map((f) => f.id),
        },
        confidence_score: 0.95,
        reasoning: `Feedback tracking: ${highCount} high-priority items stale`,
      });
      if (id) actionsCreated.push(id);
    }
  }

  return {
    actionsCreated,
    issuesFound: actionsCreated.length,
  };
}

/**
 * Calculate how far through a timeline we are (0-100%)
 */
function calculateTimelineProgress(startDate: string | Date, endDate: string | Date): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const now = new Date();

  const totalDuration = end.getTime() - start.getTime();
  const elapsed = now.getTime() - start.getTime();

  if (totalDuration <= 0) return 0;
  if (elapsed <= 0) return 0;
  if (elapsed >= totalDuration) return 100;

  return (elapsed / totalDuration) * 100;
}
