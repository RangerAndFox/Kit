// @ts-nocheck
/**
 * Call and transcript classification system
 * Determines call type, routing, and project association
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type CallType =
  | 'scoping_call'
  | 'project_kickoff'
  | 'client_review'
  | 'status_checkin'
  | 'internal_team'
  | 'post_mortem'
  | 'founder_strategy'
  | 'unknown';

export type Stream = 'team' | 'founder';

export interface CallClassification {
  callType: CallType;
  stream: Stream;
  projectId?: string;
  confidence: number;
  reasoning: string;
}

/**
 * Determine which stream a call should be routed to (team or founder)
 * Follows a hierarchical decision tree
 */
export async function determineStream(
  title: string,
  source: string,
  participants: string[]
): Promise<Stream> {
  const admin = createAdminClient();

  // Check for explicit routing markers in title
  if (
    title.includes('[private]') ||
    title.includes('[founder]') ||
    title.includes('[exec]') ||
    title.includes('[strategic]')
  ) {
    return 'founder';
  }

  // Plaud is our hardware meeting recorder; transcripts default to the founder stream.
  if (source === 'plaud') {
    return 'founder';
  }

  // Check transcription_routing rules in DB
  const { data: routingRules } = await admin
    .from('transcription_routing' as any)
    .select('target_stream')
    .or(`title_pattern.ilike.%${title}%`)
    .limit(1);

  if (routingRules && routingRules.length > 0) {
    const target = (routingRules[0] as any).target_stream;
    if (target === 'founder') return 'founder';
  }

  // Default to team stream
  return 'team';
}

/**
 * Match a call to an existing project based on participants and title keywords
 * Uses fuzzy matching on participant emails and title
 */
export async function matchToProject(
  workspaceId: string,
  participants: string[],
  title: string
): Promise<string | undefined> {
  const admin = createAdminClient();

  // Extract keywords from title
  const titleWords = title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['call', 'meeting', 'with', 'the', 'and', 'for'].includes(w));

  // Get all projects in workspace
  const { data: projects } = await admin
    .from('projects' as any)
    .select('id, name, client_name, team_members')
    .eq('workspace_id', workspaceId);

  if (!projects || projects.length === 0) return undefined;

  let bestMatch: string | undefined;
  let bestScore = 0;

  for (const project of projects) {
    let score = 0;

    // Check for participant overlap
    const projectMembers = (project.team_members as string[]) || [];
    const participantOverlap = participants.filter((p) =>
      projectMembers.some((m) => p.includes(m) || m.includes(p))
    ).length;
    score += participantOverlap * 10;

    // Check for name match
    const projectName = (project.name || '').toLowerCase();
    const clientName = (project.client_name || '').toLowerCase();

    for (const word of titleWords) {
      if (projectName.includes(word) || clientName.includes(word)) {
        score += 5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = project.id;
    }
  }

  // Only return match if we have reasonable confidence (score >= 5)
  return bestScore >= 5 ? bestMatch : undefined;
}

/**
 * Classify a call transcript by content analysis
 * Uses keyword matching and heuristics
 */
export function classifyCall(
  transcript: string,
  participants: string[]
): { callType: CallType; confidence: number } {
  const lowerTranscript = transcript.toLowerCase();
  const participantCount = participants.length;

  // Define keywords for each call type
  const typeKeywords = {
    scoping_call: [
      'scope',
      'requirements',
      'deliverables',
      'timeline',
      'budget',
      'constraints',
      'timeline',
      'how much',
      'how long',
      'what do we need',
      'what are you looking for',
    ],
    project_kickoff: [
      'kickoff',
      'officially launching',
      'lets get started',
      'heres the plan',
      'milestones',
      'first deliverable',
      'day one',
      'starting today',
      'team intros',
    ],
    client_review: [
      'review',
      'feedback',
      'thoughts',
      'revision',
      'changes',
      'adjustments',
      'what do you think',
      'look good',
      'approved',
      'not quite',
      'redo',
    ],
    status_checkin: [
      'status',
      'where are we',
      'progress',
      'on track',
      'blockers',
      'any issues',
      'update',
      'current state',
      'how is it going',
      'any risks',
    ],
    internal_team: [
      'team meeting',
      'internal',
      'debrief',
      'let\'s sync',
      'weekly standup',
      'sprint',
      'workload',
      'resource',
      'capacity',
      'whos doing what',
    ],
    post_mortem: [
      'post mortem',
      'postmortem',
      'retrospective',
      'retro',
      'lessons learned',
      'what went well',
      'what could be better',
      'next time',
      'improvement',
      'reflection',
    ],
    founder_strategy: [
      'strategy',
      'vision',
      'growth',
      'positioning',
      'market',
      'competitive',
      'ipo',
      'funding',
      'board',
      'shareholder',
    ],
  };

  // Score each call type
  const scores: Record<CallType, number> = {
    scoping_call: 0,
    project_kickoff: 0,
    client_review: 0,
    status_checkin: 0,
    internal_team: 0,
    post_mortem: 0,
    founder_strategy: 0,
    unknown: 0,
  };

  for (const [callType, keywords] of Object.entries(typeKeywords)) {
    for (const keyword of keywords) {
      const occurrences = (lowerTranscript.match(new RegExp(keyword, 'g')) || []).length;
      scores[callType as CallType] += occurrences;
    }
  }

  // Apply heuristics
  // Internal team calls usually have more participants and informal language
  if (participantCount > 2 && lowerTranscript.includes('hey team')) {
    scores.internal_team += 3;
  }

  // Founder strategy calls are typically shorter and more executive
  if (
    participantCount <= 2 &&
    (transcript.length < 5000 || lowerTranscript.includes('strategic'))
  ) {
    scores.founder_strategy += 2;
  }

  // Find the best match
  let bestType: CallType = 'unknown';
  let bestScore = 0;

  for (const [callType, score] of Object.entries(scores)) {
    if (score > bestScore && callType !== 'unknown') {
      bestScore = score;
      bestType = callType as CallType;
    }
  }

  // Calculate confidence (0-1)
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  let confidence = totalScore > 0 ? bestScore / totalScore : 0;

  // If no keywords matched, confidence is very low
  if (bestScore === 0) {
    confidence = 0.1;
    bestType = 'unknown';
  }

  return { callType: bestType, confidence };
}

/**
 * Process a full transcript through the classification pipeline
 * Determine stream → match to project → classify call type → save results
 */
export async function processTranscript(
  workspaceId: string,
  transcript: string,
  title: string,
  source: string,
  participants: string[]
): Promise<CallClassification> {
  // Step 1: Determine stream (team or founder)
  const stream = await determineStream(title, source, participants);

  // Step 2: Match to project
  const projectId = await matchToProject(workspaceId, participants, title);

  // Step 3: Classify call type
  const { callType, confidence } = classifyCall(transcript, participants);

  const classification: CallClassification = {
    callType,
    stream,
    projectId,
    confidence,
    reasoning: `Classified as ${callType} (${(confidence * 100).toFixed(0)}% confidence). Routed to ${stream} stream${projectId ? ` for project ${projectId}` : '.'}`,
  };

  // Step 4: Save to database
  const admin = createAdminClient();

  // First, create a call_classifications record
  const { data: classificationRecord, error: classificationError } = await admin
    .from('call_classifications' as any)
    .insert({
      workspace_id: workspaceId,
      project_id: projectId,
      transcript_excerpt: transcript.substring(0, 500),
      call_type: callType,
      stream,
      participants_count: participants.length,
      confidence_score: confidence,
      source,
      title,
      classification_metadata: {
        participants,
        reasoning: classification.reasoning,
      },
    })
    .select('id')
    .single();

  if (classificationError) {
    console.error('Failed to save call classification:', classificationError);
  } else if (classificationRecord) {
    // Create action_breakdown record if applicable
    if (callType !== 'unknown') {
      const breakdownDescription = getActionBreakdownDescription(callType);

      await admin
        .from('action_breakdowns' as any)
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          source_type: 'call_classification',
          source_id: (classificationRecord as any).id,
          description: breakdownDescription,
          metadata: {
            call_type: callType,
            stream,
            transcript_length: transcript.length,
          },
        })
        .select('id');
    }
  }

  return classification;
}

/**
 * Get suggested action breakdown based on call type
 */
function getActionBreakdownDescription(callType: CallType): string {
  const descriptions: Record<CallType, string> = {
    scoping_call:
      'Capture scope requirements, timeline estimates, budget parameters, and identified deliverables',
    project_kickoff: 'Create project milestones, assign team members, establish communication cadence',
    client_review:
      'Log feedback items, prioritize revisions, update deliverable status, schedule follow-up',
    status_checkin:
      'Record project progress, identify blockers, assess timeline health, note resource needs',
    internal_team:
      'Capture team insights, workload assessments, process improvements, skill development areas',
    post_mortem:
      'Document lessons learned, identify process improvements, capture best practices and risk factors',
    founder_strategy:
      'Record strategic decisions, market insights, positioning updates, growth priorities',
    unknown: 'Manual review required to determine action items',
  };

  return descriptions[callType];
}
