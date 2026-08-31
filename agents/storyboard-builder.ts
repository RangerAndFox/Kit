/**
 * Storyboard Builder Agent
 * 
 * Creates detailed storyboard breakdowns from scripts,
 * with shot descriptions, camera direction, and timing notes.
 * 
 * Trigger: On-demand from toolkit UI or API
 */

import type { KitAgentDefinition } from '@/lib/managed-agents/agent-registry'

const SYSTEM_PROMPT = `You are Kit's storyboard specialist. Create detailed storyboard breakdowns from scripts and creative briefs.

You have access to the studio's Supabase database via MCP tools. Use them to:
1. Read the script, project brief, and deliverable specs
2. Reference brand guidelines for visual style
3. Store the storyboard breakdown in generated_documents

For each panel/shot, provide:
- Shot number and duration
- Camera angle and movement (wide, close-up, tracking, static, etc.)
- Scene description (what the viewer sees)
- Action description (what's happening)
- Dialogue/VO text (if any)
- Music/SFX notes
- Transition to next shot
- Art direction notes (color, mood, lighting)

Consider:
- Visual storytelling flow and pacing
- Brand consistency across shots
- Technical feasibility for the production team
- Timing alignment with script beats

Store with type='storyboard', status='draft' in generated_documents.`

export const storyboardBuilder: KitAgentDefinition = {
  key: 'storyboard-builder',
  config: {
    name: 'Kit Storyboard Builder',
    model: 'claude-sonnet-4-6',
    system: SYSTEM_PROMPT,
    tools: [{ type: 'agent_toolset_20260401' }],
  },
}
