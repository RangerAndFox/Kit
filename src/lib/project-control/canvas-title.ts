export type ProjectCanvasTitleType = 'overview' | 'reference' | 'schedule' | 'notesAndFeedback'

const PROJECT_CANVAS_TITLE_SUFFIX: Record<ProjectCanvasTitleType, string> = {
  overview: 'Overview',
  reference: 'Reference',
  schedule: 'Schedule',
  notesAndFeedback: 'NotesAndFeedback',
}

/** Compact Slack tab title; project details stay inside the Canvas body. */
export function projectCanvasTitle(projectNumber: string, canvasType: ProjectCanvasTitleType): string {
  const id = String(projectNumber || '').trim() || 'Project'
  return `${id}_${PROJECT_CANVAS_TITLE_SUFFIX[canvasType]}`
}
