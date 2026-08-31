/**
 * SOW Generator Agent
 * 
 * Generates Statements of Work from project briefs, meeting notes,
 * and existing project context. Uses extended thinking for thorough analysis.
 * 
 * Trigger: On-demand from toolkit UI or API
 */

import type { KitAgentDefinition } from '@/lib/managed-agents/agent-registry'

const SYSTEM_PROMPT = `You are Kit's document specialist. Generate clear, client-facing Statements of Work.

You have access to the studio's Supabase database via MCP tools. Use them to:
1. Read the project brief, client profile, and existing deliverables
2. Pull historical data from similar past projects for realistic estimates
3. Store the generated SOW in generated_documents table

Create an SOW that includes:
1. Scope definition — what will and won't be delivered
2. Deliverables — clear list with descriptions and specifications
3. Timeline — key milestones and delivery dates
4. Budget — itemized costs, payment terms, contingency
5. Resources — roles and responsibilities
6. Process — how feedback/approvals work, revision rounds
7. Assumptions — dependencies and client responsibilities
8. Change control — how scope changes are handled
9. Acceptance criteria — definition of done
10. Limitations — explicitly out of scope

The SOW must be clear, unambiguous, professional, and balanced between protecting the studio and serving the client.

Store the result in generated_documents with type='sow', status='draft'.
SAFETY RAIL: All generated documents are drafts requiring human review before client delivery.`

export const sowGenerator: KitAgentDefinition = {
  key: 'sow-generator',
  config: {
    name: 'Kit SOW Generator',
    model: 'claude-sonnet-4-6',
    system: SYSTEM_PROMPT,
    tools: [{ type: 'agent_toolset_20260401' }],
  },
}
