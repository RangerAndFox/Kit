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

interface MatchableProject {
  id: string;
  name: string | null;
  client: string | null;
  project_code: string | null;
}

async function loadMatchableProjects(workspaceId: string): Promise<MatchableProject[]> {
  const admin = createAdminClient();
  const { data: projects } = await admin
    .from('projects' as any)
    .select('id, name, client, project_code, status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');
  // Placeholder rows ("Unknown") can never be a meaningful match.
  return ((projects as any[]) || []).filter(
    (p) => (p.name || '').trim().toLowerCase() !== 'unknown'
  );
}

/**
 * Match a call to an existing project based on title keywords.
 * Uses fuzzy matching on the title against project name / client / code.
 */
export async function matchToProject(
  workspaceId: string,
  _participants: string[],
  title: string
): Promise<string | undefined> {
  const projects = await loadMatchableProjects(workspaceId);
  if (projects.length === 0) return undefined;

  // Extract keywords from title
  const titleWords = title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['call', 'meeting', 'with', 'the', 'and', 'for'].includes(w));

  let bestMatch: string | undefined;
  let bestScore = 0;

  for (const project of projects) {
    let score = 0;
    const projectName = (project.name || '').toLowerCase();
    const clientName = (project.client || '').toLowerCase();
    const projectCode = (project.project_code || '').toLowerCase();

    for (const word of titleWords) {
      if (projectName.includes(word) || (projectCode && projectCode.includes(word))) {
        score += 5;
      } else if (clientName && clientName.includes(word)) {
        score += 2;
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
 * Count how strongly a transcript talks about one project. Pure — tested.
 * Name and code hits are strong signals; client alone is weak (nearly every
 * R&F call mentions "Microsoft") so it only breaks ties.
 */
export function scoreProjectMentions(
  text: string,
  project: { name: string | null; client: string | null; project_code: string | null }
): number {
  const countOf = (needle: string): number => {
    if (!needle || needle.length < 4) return 0;
    let n = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      n++;
      idx = text.indexOf(needle, idx + needle.length);
    }
    return n;
  };
  const name = (project.name || '').trim().toLowerCase();
  const code = (project.project_code || '').trim().toLowerCase();
  const client = (project.client || '').trim().toLowerCase();
  return countOf(name) * 3 + countOf(code) * 5 + Math.min(countOf(client), 2);
}

/**
 * Content-aware project matching for full transcripts (Drive/Plaud ingests).
 *
 * A transcript is attached to a project only when ONE project clearly
 * dominates the conversation. Weekly/internal meetings that touch several
 * projects stay workspace-level (null) — pinning them to one project at
 * random would surface the wrong "last meeting" in briefings. Order:
 *   1. Title names exactly one project → that project.
 *   2. Mention counting over the transcript → accept a dominant winner.
 *   3. Ambiguous (several projects discussed) → Haiku picks the PRIMARY
 *      subject, or none. Non-fatal: any LLM failure degrades to null.
 */
export async function matchTranscriptToProject(opts: {
  workspaceId: string;
  title: string;
  transcript: string;
}): Promise<string | null> {
  const projects = await loadMatchableProjects(opts.workspaceId);
  if (projects.length === 0) return null;

  const byTitle = await matchToProject(opts.workspaceId, [], opts.title);
  if (byTitle) return byTitle;

  const text = opts.transcript.slice(0, 60_000).toLowerCase();
  const scored = projects
    .map((p) => ({ p, score: scoreProjectMentions(text, p) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  if (scored.length === 1 && scored[0].score >= 6) return scored[0].p.id;
  if (scored.length > 1 && scored[0].score >= 9 && scored[0].score >= scored[1].score * 2) {
    return scored[0].p.id;
  }

  // Multiple projects in play with no dominant one — let a small model judge
  // whether the meeting is ABOUT one of them or just mentions them in passing.
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const candidates = scored
      .slice(0, 6)
      .map((s) => `${s.p.id} — ${s.p.name}${s.p.client ? ` (${s.p.client})` : ''}`)
      .join('\n');
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system:
        'You classify meeting transcripts for a video production studio. Given candidate ' +
        'projects and a transcript excerpt, decide whether the meeting is PRIMARILY about ' +
        'exactly one of the candidates. Passing mentions, status roundups covering several ' +
        'projects, or business-development calls are NOT a match. Respond with ONLY the ' +
        'project id, or the word none.',
      messages: [
        {
          role: 'user',
          content: `Candidates:\n${candidates}\n\nMeeting title: ${opts.title || '(untitled)'}\n\nTranscript excerpt:\n${opts.transcript.slice(0, 4_000)}`,
        },
      ],
    });
    const answer = res.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
      .trim();
    const picked = scored.find((s) => answer.includes(s.p.id));
    return picked ? picked.p.id : null;
  } catch (err: any) {
    console.warn('[call-classifier] LLM project match failed:', err?.message || err);
    return null;
  }
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
