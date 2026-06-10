/**
 * Task cards API - manages daily task cards for team
 * GET /api/toolkit/task-cards - returns today's task cards
 * POST /api/toolkit/task-cards - handles actions: generate, approve, distribute
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface TaskCard {
  id: string;
  workspace_id: string;
  task_type: string;
  title: string;
  description: string;
  assigned_to?: string;
  status: 'draft' | 'approved' | 'distributed' | 'completed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  project_id?: string;
  milestone_id?: string;
  created_at: string;
  updated_at: string;
  approved_at?: string;
  distributed_at?: string;
}

interface TaskCardRequest {
  workspaceId: string;
  action?: 'generate' | 'approve' | 'distribute';
  cardIds?: string[];
  assignTo?: string;
}

interface TaskCardResponse {
  cards?: TaskCard[];
  message: string;
  count?: number;
}

/**
 * GET /api/toolkit/task-cards
 * Returns task cards for today
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const searchParams = request.nextUrl.searchParams;
    const workspaceId = searchParams.get('workspaceId');
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Fetch task cards for the specified date
    const { data: cards, error } = await supabase
      .from('task_cards' as any)
      .select('*')
      .eq('workspace_id', workspaceId)
      .gte('created_at', `${date}T00:00:00Z`)
      .lt('created_at', `${date}T23:59:59Z`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ error: `Failed to fetch task cards: ${error.message}` }, { status: 500 });
    }

    const response: TaskCardResponse = {
      cards: cards as unknown as TaskCard[],
      message: `Found ${cards?.length || 0} task cards for ${date}`,
      count: cards?.length || 0,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Task cards GET error:', error);

    const message = error instanceof Error ? error.message : 'Failed to fetch task cards';
    return NextResponse.json({ error: message, message: '' }, { status: 500 });
  }
}

/**
 * POST /api/toolkit/task-cards
 * Handles task card actions: generate, approve, distribute
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as TaskCardRequest;
    const { workspaceId, action = 'generate', cardIds = [], assignTo } = body;

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const supabase = createAdminClient();

    switch (action) {
      case 'generate':
        return await handleGenerateCards(supabase, workspaceId);

      case 'approve':
        return await handleApproveCards(supabase, cardIds);

      case 'distribute':
        return await handleDistributeCards(supabase, cardIds, assignTo);

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('Task cards POST error:', error);

    const message = error instanceof Error ? error.message : 'Failed to process task cards';
    return NextResponse.json({ error: message, message: '' }, { status: 500 });
  }
}

/**
 * Generates task cards for the workspace
 * Analyzes pending work and creates daily task cards
 */
async function handleGenerateCards(supabase: any, workspaceId: string): Promise<NextResponse> {
  try {
    // Fetch projects and milestones to generate tasks from
    const { data: projects } = await supabase.from('projects' as any).select('*').eq('workspace_id', workspaceId).in('status', ['planning', 'in_progress']);

    if (!projects || projects.length === 0) {
      return NextResponse.json({ message: 'No active projects to generate tasks from', count: 0 }, { status: 200 });
    }

    const generatedCards: TaskCard[] = [];
    const now = new Date().toISOString();

    // For each project, generate relevant task cards
    for (const project of projects) {
      // Fetch milestones that are approaching
      const { data: milestones } = await supabase
        .from('milestones' as any)
        .select('*')
        .eq('project_id', project.id)
        .in('status', ['not_started', 'in_progress'])
        .order('due_date', { ascending: true })
        .limit(2);

      if (!milestones) continue;

      for (const milestone of milestones) {
        const daysUntilDue = Math.ceil((new Date(milestone.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

        // Create task card for milestones due soon
        if (daysUntilDue <= 7 && milestone.status === 'not_started') {
          const card: TaskCard = {
            id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            workspace_id: workspaceId,
            task_type: 'milestone_prep',
            title: `Start: ${milestone.name}`,
            description: `Begin work on "${milestone.name}" milestone (Due: ${new Date(milestone.due_date).toLocaleDateString()})`,
            status: 'draft',
            priority: daysUntilDue <= 2 ? 'critical' : 'high',
            project_id: project.id,
            milestone_id: milestone.id,
            created_at: now,
            updated_at: now,
          };

          generatedCards.push(card);
        }
      }

      // Fetch deliverables that are in review
      const { data: deliverables } = await supabase
        .from('deliverables' as any)
        .select('*')
        .eq('project_id', project.id)
        .eq('status', 'in_review')
        .limit(3);

      if (deliverables && deliverables.length > 0) {
        for (const deliv of deliverables) {
          const card: TaskCard = {
            id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            workspace_id: workspaceId,
            task_type: 'review_followup',
            title: `Follow up: ${deliv.name} review`,
            description: `Check on feedback and revisions for "${deliv.name}" (In review)`,
            status: 'draft',
            priority: 'medium',
            project_id: project.id,
            created_at: now,
            updated_at: now,
          };

          generatedCards.push(card);
        }
      }
    }

    // Insert generated cards
    if (generatedCards.length > 0) {
      const { error: insertError } = await supabase.from('task_cards' as any).insert(generatedCards);

      if (insertError) {
        console.error('Failed to insert task cards:', insertError);
        return NextResponse.json({ error: 'Failed to generate task cards' }, { status: 500 });
      }
    }

    const response: TaskCardResponse = {
      cards: generatedCards,
      message: `Generated ${generatedCards.length} task cards`,
      count: generatedCards.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error generating cards:', error);
    return NextResponse.json({ error: 'Failed to generate task cards', message: '' }, { status: 500 });
  }
}

/**
 * Approves task cards (moves from draft to approved)
 */
async function handleApproveCards(supabase: any, cardIds: string[]): Promise<NextResponse> {
  if (!cardIds || cardIds.length === 0) {
    return NextResponse.json({ error: 'cardIds are required' }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('task_cards' as any)
      .update({
        status: 'approved',
        approved_at: now,
        updated_at: now,
      })
      .in('id', cardIds);

    if (error) {
      return NextResponse.json({ error: `Failed to approve cards: ${error.message}` }, { status: 500 });
    }

    const response: TaskCardResponse = {
      message: `Approved ${cardIds.length} task card(s)`,
      count: cardIds.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error approving cards:', error);
    return NextResponse.json({ error: 'Failed to approve task cards', message: '' }, { status: 500 });
  }
}

/**
 * Distributes task cards to team members (moves from approved to distributed)
 */
async function handleDistributeCards(supabase: any, cardIds: string[], assignTo?: string): Promise<NextResponse> {
  if (!cardIds || cardIds.length === 0) {
    return NextResponse.json({ error: 'cardIds are required' }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();

    const updateData: any = {
      status: 'distributed',
      distributed_at: now,
      updated_at: now,
    };

    if (assignTo) {
      updateData.assigned_to = assignTo;
    }

    const { error } = await supabase.from('task_cards' as any).update(updateData).in('id', cardIds);

    if (error) {
      return NextResponse.json({ error: `Failed to distribute cards: ${error.message}` }, { status: 500 });
    }

    const response: TaskCardResponse = {
      message: `Distributed ${cardIds.length} task card(s)${assignTo ? ` to ${assignTo}` : ''}`,
      count: cardIds.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error distributing cards:', error);
    return NextResponse.json({ error: 'Failed to distribute task cards', message: '' }, { status: 500 });
  }
}
