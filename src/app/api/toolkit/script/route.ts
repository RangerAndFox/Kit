// @ts-nocheck
/**
 * Script generation API
 * POST /api/toolkit/script
 * Generates video/audio scripts with RAG context using Claude Sonnet
 */

import { NextRequest, NextResponse } from 'next/server';
import { Anthropic } from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/supabase/admin';
import { searchDocuments, buildContext } from '@/lib/rag/query';
import { buildPrompt } from '@/lib/agent/personality';
import { scriptWritingPrompt } from '@/lib/agent/prompts';
import type { Project } from '@/types/database';

interface ScriptRequest {
  projectId: string;
  workspaceId: string;
  scriptType?: string;
}

interface ScriptResponse {
  content: string;
  metadata: {
    generatedAt: string;
    model: string;
    documentId?: string;
    ragSources?: number;
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as ScriptRequest;
    const { projectId, workspaceId, scriptType = 'video' } = body;

    // Validate required fields
    if (!projectId || !workspaceId) {
      return NextResponse.json({ error: 'projectId and workspaceId are required' }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Fetch project data
    const { data: project, error: projectError } = await supabase
      .from('projects' as any)
      .select('*')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Fetch workspace
    const { data: workspace } = await supabase.from('workspaces' as any).select('name, settings').eq('id', workspaceId).single();

    // Query RAG system for relevant documents
    let ragContext = '';
    let ragSourceCount = 0;

    try {
      // queryWithContext was removed in the studio-knowledge P1 rewrite of
      // rag/query.ts — compose the same thing from its replacements.
      // (Old maxTokens: 2000 ≈ 8000 chars; buildContext budgets by chars.)
      const ragResults = await searchDocuments(`${project.name} script requirements brief deliverables`, {
        workspaceId,
        projectId,
        limit: 5,
      });

      ragContext = buildContext(ragResults, 8_000);
      ragSourceCount = ragResults.length;
    } catch (ragError) {
      console.warn('RAG query failed, continuing without context:', ragError);
      // Continue without RAG context
    }

    // Build project context
    const projectContext = buildProjectContext({
      project: project as Project,
      scriptType,
      ragContext,
    });

    // Build the prompt with personality
    const personalityConfig = (workspace?.settings as any)?.personality || {
      formality: 50,
      playfulness: 40,
    };

    const workspaceContext = {
      personality: personalityConfig,
      name: workspace?.name || 'Studio',
    };

    const fullPrompt = buildPrompt(workspaceContext, scriptWritingPrompt(projectContext), 'chat');

    // Call Claude Sonnet
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: fullPrompt,
      messages: [
        {
          role: 'user',
          content: `Write a compelling ${scriptType} script for this project. Format it appropriately for the medium and include all necessary production notes, timing cues, and talent guidance.`,
        },
      ],
    });

    // Extract the generated content
    const textContent = message.content.find((block) => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in Claude response');
    }

    const scriptContent = textContent.text;

    // Save to generated_documents table
    const { data: savedDoc } = await supabase
      .from('generated_documents' as any)
      .insert({
        project_id: projectId,
        workspace_id: workspaceId,
        doc_type: `script_${scriptType}`,
        content: scriptContent,
        metadata: {
          generatedAt: new Date().toISOString(),
          model: 'claude-sonnet-4-20250514',
          scriptType,
          ragSourcesUsed: ragSourceCount,
        },
      })
      .select('id')
      .single();

    const response: ScriptResponse = {
      content: scriptContent,
      metadata: {
        generatedAt: new Date().toISOString(),
        model: 'claude-sonnet-4-20250514',
        documentId: savedDoc?.id,
        ragSources: ragSourceCount,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Script generation error:', error);

    const message = error instanceof Error ? error.message : 'Failed to generate script';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Builds project context for script generation
 */
function buildProjectContext(data: { project: Project; scriptType: string; ragContext: string }): string {
  const { project, scriptType, ragContext } = data;

  const lines: string[] = [];

  lines.push('PROJECT CONTEXT');
  lines.push(`Project: ${project.name}`);
  lines.push(`Description: ${project.description || 'N/A'}`);
  lines.push(`Client: ${project.client_name || 'N/A'}`);
  lines.push(`Script Type: ${scriptType}`);
  lines.push(`Status: ${project.status}`);
  lines.push(`Deadline: ${new Date(project.end_date).toLocaleDateString()}`);
  lines.push('');

  if (ragContext) {
    lines.push('RELEVANT DOCUMENTATION');
    lines.push(ragContext);
    lines.push('');
  }

  lines.push('INSTRUCTIONS');
  lines.push(`Generate a professional ${scriptType} script that:`);
  lines.push('- Communicates the core message clearly');
  lines.push('- Has appropriate pacing and rhythm for the medium');
  lines.push('- Includes production notes and talent guidance');
  lines.push('- Specifies visual/audio direction as appropriate');
  lines.push('- Includes timing and duration notes');
  lines.push('- Matches professional industry standards for the format');

  return lines.join('\n');
}
