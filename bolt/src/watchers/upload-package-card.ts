import type { KnownBlock, ModalView } from '@slack/types'
import type { UploadPackagePage } from '../../../src/lib/delivery/upload-package'

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const short = (value: string, length = 900) => value.length > length ? `${value.slice(0, length - 1)}…` : value
const location = (id: string, after: string | null = null) => JSON.stringify({ id, after })
const frameReviewUrl = (value?: string | null): string | undefined => {
  if (!value) return
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'f.io' || url.hostname === 'frame.io' || url.hostname.endsWith('.frame.io'))) return value
  } catch { /* Do not turn an unrecognized receipt into a clickable link. */ }
}

export function uploadPackageCard(page: UploadPackagePage, label: string): { text: string; blocks: KnownBlock[] } {
  const text = `Delivery folder — ${label}: ${page.awaiting} awaiting review`
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${short(escape(text))}*\n${short(escape(page.package.root_path))}\n${page.total} files · ${page.awaiting} awaiting review\nThis card updates as files arrive. Review and rename individual files inside the folder; nothing is bulk-approved.` } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'kit_delivery_package_open', value: location(page.package.id),
        text: { type: 'plain_text', text: 'Review delivery folder' }, style: 'primary' }] },
    ],
  }
}

export function uploadPackageModal(page: UploadPackagePage, after: string | null = null): ModalView {
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'plain_text', text: `${short(page.package.root_path)}\n${page.total} files · ${page.awaiting} awaiting review. Choose a file to edit its name and approve its exact revision. Close the file form to return here, then Refresh for the latest status.` } },
  ]
  for (const row of page.approvals) {
    const relative = row.source_path.toLowerCase().startsWith(`${page.package.root_path.toLowerCase()}/`)
      ? row.source_path.slice(page.package.root_path.length + 1) : row.source_path
    const name = row.approved_name || row.suggested_name
    const attribution = row.approved_by && /^[UW][A-Z0-9]+$/.test(row.approved_by) ? ` · <@${row.approved_by}>` : ''
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${short(escape(relative))}*\n${escape(row.state.replace(/_/g, ' '))}${attribution}\n${row.approved_name ? 'Approved filename' : 'Suggested name'}: ${short(escape(name), 240)}${row.state === 'collision' ? '\nOnly the original approver can resolve the duplicate in their private Kit DM.' : ''}` } })
    if (row.state === 'awaiting') blocks.push({ type: 'actions', block_id: `file_${row.id}`, elements: [
      { type: 'button', action_id: 'kit_frame_upload_review', value: row.id, text: { type: 'plain_text', text: 'Review & rename' }, style: 'primary' },
      { type: 'button', action_id: 'kit_frame_upload_skip', value: row.id, text: { type: 'plain_text', text: 'Skip' } },
    ] })
    const reviewUrl = row.state === 'complete' ? frameReviewUrl(row.frame_review_url) : undefined
    if (reviewUrl) blocks.push({ type: 'actions', block_id: `share_${row.id}`, elements: [
      { type: 'button', action_id: 'kit_delivery_package_share', url: reviewUrl, text: { type: 'plain_text', text: 'Open folder in Frame' } },
    ] })
  }
  if (!page.approvals.length) blocks.push({ type: 'section', text: { type: 'plain_text', text: 'No current files on this page. Refresh or return to the first page.' } })
  const navigation: Extract<KnownBlock, { type: 'actions' }>['elements'] = [
    { type: 'button', action_id: 'kit_delivery_package_page', value: location(page.package.id, after), text: { type: 'plain_text', text: 'Refresh' } },
  ]
  if (after) navigation.push({ type: 'button', action_id: 'kit_delivery_package_first', value: location(page.package.id), text: { type: 'plain_text', text: 'First page' } })
  if (page.next_cursor) navigation.push({ type: 'button', action_id: 'kit_delivery_package_next', value: location(page.package.id, page.next_cursor), text: { type: 'plain_text', text: 'Next files' } })
  blocks.push({ type: 'actions', elements: navigation })
  return { type: 'modal', callback_id: 'kit_delivery_package_view', private_metadata: location(page.package.id, after),
    title: { type: 'plain_text', text: 'Review delivery folder' }, close: { type: 'plain_text', text: 'Close' }, blocks }
}
