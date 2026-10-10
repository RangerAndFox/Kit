/** Read-before-write reconciliation, following the project-control canvas
 * adapter. Each managed block is one section; never replace the whole canvas. */
export type SlackCall = (method: string, data: Record<string, unknown>) => Promise<{ sections?: Array<{ id: string }> }>
async function call(method: string, data: Record<string, unknown>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(45_000), redirect: 'error',
  })
  const json = await response.json()
  if (!response.ok || !json.ok) throw new Error('feedback_canvas_write_failed')
  return json
}
export async function publishSection(input: {
  canvasId: string; marker: string; type: 'h3' | 'table'; markdown: string; changed: boolean;
  assertOwned(): Promise<void>
}, slack: SlackCall = call): Promise<void> {
  const found = await slack('canvases.sections.lookup', { canvas_id: input.canvasId,
    criteria: { section_types: [input.type], contains_text: input.marker } })
  if (!Array.isArray(found.sections)) throw new Error('feedback_canvas_lookup_incomplete')
  if (found.sections.length > 1) throw new Error('feedback_canvas_marker_ambiguous')
  if (!input.changed && found.sections.length === 1) return
  // Never reuse section IDs from another pass or allow an expired worker to edit.
  await input.assertOwned()
  await slack('canvases.edit', { canvas_id: input.canvasId, changes: [{
    operation: found.sections.length ? 'replace' : 'insert_at_end',
    ...(found.sections.length ? { section_id: found.sections[0].id } : {}),
    document_content: { type: 'markdown', markdown: input.markdown },
  }] })
}
