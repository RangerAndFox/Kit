import type { App } from '@slack/bolt'
import { parseUploadPackageLocation } from '../../../src/lib/delivery/upload-package'
import { getAuthorizedUploadPackagePage } from '../../../src/lib/delivery/upload-package-store'
import { uploadPackageModal } from './upload-package-card'

export function registerUploadPackageHandlers(app: App): void {
  app.action('kit_delivery_package_share', async ({ ack }) => { await ack() })
  app.action(/^kit_delivery_package_(open|page|first|next)$/, async ({ ack, body, action, client }) => {
    await ack()
    let viewId: string | undefined
    try {
      if (!('value' in action) || !action.value || !('trigger_id' in body)) throw new Error('Open the current delivery folder card.')
      const where = parseUploadPackageLocation(action.value)
      if ('view' in body && body.view?.callback_id === 'kit_delivery_package_view') viewId = body.view.id
      else {
        viewId = (await client.views.open({ trigger_id: body.trigger_id, view: {
          type: 'modal', title: { type: 'plain_text', text: 'Delivery folder' }, close: { type: 'plain_text', text: 'Close' },
          blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Checking your project access and loading the folder.' } }],
        } })).view?.id
      }
      if (!viewId) throw new Error('Slack did not open the folder review.')
      const page = await getAuthorizedUploadPackagePage(where.id, where.after, body.team?.id || '', body.user.id)
      await client.views.update({ view_id: viewId, view: uploadPackageModal(page, where.after) })
    } catch {
      // No source details or unsolicited fallback DMs on denied/stale clicks.
      if (viewId) await client.views.update({ view_id: viewId, view: {
        type: 'modal', title: { type: 'plain_text', text: 'Review unavailable' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'plain_text', text: 'This folder review is unavailable or your access changed. Reopen the current delivery folder card.' } }],
      } })
      else console.warn('[upload-review] Could not open delivery folder review')
    }
  })
}
