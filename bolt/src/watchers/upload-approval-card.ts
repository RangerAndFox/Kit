import type { KnownBlock } from '@slack/types'
import type { UploadApproval, UploadSource } from '../../../src/lib/delivery/upload-approval'

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const actor = (row: UploadApproval) => row.approved_by && /^[UW][A-Z0-9]+$/.test(row.approved_by)
  ? `<@${row.approved_by}>` : 'another reviewer'

export function decidedUploadMessage(row: UploadApproval): string {
  if (row.state === 'collision') return `Approved by ${actor(row)} as ${escape(row.approved_name || row.suggested_name)}. Upload is paused; only that approver can resolve the duplicate in their private Kit DM.`
  if (row.state === 'superseded') return 'This request was superseded by a changed source. Review the latest request. No upload was queued by this submission.'
  const decision = row.decision === 'skip' ? `Skipped by ${actor(row)}.`
    : `Already approved by ${actor(row)} as ${escape(row.approved_name || row.suggested_name)}.`
  return `${decision} Your submission did not change the filename or queue another upload.`
}

export function uploadApprovalCard(row: UploadApproval, label: string): { text: string; blocks: KnownBlock[] } {
  const source = row.source_payload as unknown as UploadSource
  const kind = /02_Delivery/i.test(source.subfolder) ? 'Delivery' : 'Client Progress'
  const text = `${kind} — ${label}: ${row.state === 'awaiting' ? 'ready for review' : row.state.replace('_', ' ')}`
  const attribution = row.approved_by ? `\n${row.decision === 'skip' ? 'Skipped' : 'Approved'} by ${actor(row)}` : ''
  const nameLabel = row.approved_name ? 'Approved filename' : 'Suggested name'
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(text)}*\n${escape(row.source_path)}\n${nameLabel}: ${escape(row.approved_name || row.suggested_name)}${attribution}${row.detail ? `\n${escape(row.detail)}` : ''}` } },
  ]
  if (row.state === 'awaiting') blocks.push({ type: 'actions', elements: [
    { type: 'button', action_id: 'kit_frame_upload_review', value: row.id, text: { type: 'plain_text', text: 'Review & upload' }, style: 'primary' },
    { type: 'button', action_id: 'kit_frame_upload_skip', value: row.id, text: { type: 'plain_text', text: 'Skip' } },
  ] })
  return { text, blocks }
}
