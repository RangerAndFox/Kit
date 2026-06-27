// @ts-nocheck
/**
 * After Effects render modal — opened by `/kit render`.
 *
 * Deliberately minimal: the only input is the Dropbox path to the .aep. Kit
 * reads the project's own After Effects render queue and renders every queued
 * item with its existing render settings + output module, frame-split across the
 * studio's AE machines. No comp / frames / fps / profile to fill in.
 *
 * Spec: AE-RENDER-FARM-SPEC.md, "Render-queue-driven renders".
 */

export const AE_RENDER_CALLBACK_ID = 'kit_ae_render_submit'

export function buildRenderModal(opts: { projectPath?: string; channelId?: string } = {}) {
  return {
    type: 'modal',
    callback_id: AE_RENDER_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId: opts.channelId || '' }),
    title: { type: 'plain_text', text: 'Render on the farm' },
    submit: { type: 'plain_text', text: 'Render' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ":clapper: I'll read this project's *After Effects render queue* and render every queued item " +
            'using its existing output settings — split across the studio’s machines. No other details needed.',
        },
      },
      {
        type: 'input',
        block_id: 'aep_block',
        label: { type: 'plain_text', text: 'After Effects project (.aep)' },
        element: {
          type: 'plain_text_input',
          action_id: 'aep_path',
          initial_value: opts.projectPath || '',
          placeholder: { type: 'plain_text', text: '/Projects/Acme/Acme.aep' },
        },
        hint: {
          type: 'plain_text',
          text: 'Dropbox path to the .aep (it must be synced on the render machines). Queue your comps in After Effects first.',
        },
      },
    ],
  }
}
