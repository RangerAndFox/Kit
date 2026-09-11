/** Full projects are created only by the confirmed, durable Project Control flow. */
export function isLegacyProjectProvision(agentId: string, action: string): boolean {
  return action === 'provision' && ['slack', 'frameio', 'harvest', 'dropbox'].includes(agentId)
}

export const PROJECT_INTAKE_REQUIRED = 'Full project creation is available only through Kit’s current New Project form in a private DM. Ask the user to DM Kit and type “new project”, then complete and submit the form. Never create project services separately or collect the retired four-field intake in chat.'
