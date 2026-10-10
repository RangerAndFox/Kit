import type { ModalView, KnownBlock } from '@slack/types'
import { distinctUploadName, type UploadApproval } from '../../../src/lib/delivery/upload-approval'

type Child = { id: string; name: string; type: string }
export type CollisionChoice = { decision: string; name: string; conflict?: { id: string; type: string } }

export function assertCollisionOwner(row: UploadApproval, user: string, version?: number): void {
  if (row.state !== 'collision' || (version !== undefined && version !== row.approval_version)) {
    throw new Error('This duplicate-name request has changed or was already resolved. Open the latest card.')
  }
  if (!row.approved_by || row.approved_by !== user) throw new Error('Only the person who approved this upload can resolve its duplicate filename.')
}

export function collisionChoices(row: UploadApproval, children: Child[]): CollisionChoice[] {
  if (!row.approved_name) throw new Error('The approved filename is missing.')
  const name = row.approved_name
  const matches = children.filter(c => c.name.toLowerCase() === name.toLowerCase())
  if (!matches.length) return [{ decision: 'new', name }, { decision: 'skip', name }]
  const choices: CollisionChoice[] = []
  if (matches.length === 1 && ['file','version_stack'].includes(matches[0].type)) {
    choices.push({ decision: 'replace', name, conflict: { id: matches[0].id, type: matches[0].type } })
  }
  choices.push({ decision: 'keep_both', name: distinctUploadName(name, children.map(c => c.name)) }, { decision: 'skip', name })
  return choices
}

const labels: Record<string,string> = { replace: 'Replace — add a version', keep_both: 'Keep both — add a number', skip: 'Skip — upload nothing', new: 'Upload — name is now available' }
export function collisionModal(row: UploadApproval, children: Child[]): ModalView {
  const choices = collisionChoices(row, children)
  const duplicate = !choices.some(c => c.decision === 'new')
  const numbered = choices.find(c => c.decision === 'keep_both')
  return {
    type: 'modal', callback_id: 'kit_frame_collision_choose', private_metadata: JSON.stringify({ id: row.id, version: row.approval_version }),
    title: { type: 'plain_text', text: 'Duplicate filename' }, submit: { type: 'plain_text', text: 'Continue' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: `${duplicate ? 'Frame already contains this filename in the destination folder:' : 'The matching file is no longer in the destination folder:'}\n${row.approved_name}\n\nNothing has been renamed or uploaded.${numbered ? `\nKeep both will use: ${numbered.name}` : ''}\nReplace adds a version and retains previous files and comments.${duplicate && !choices.some(c => c.decision === 'replace') ? '\nMultiple or unsupported matches: Replace is unavailable to avoid changing the wrong item.' : ''}` } },
      { type: 'input', block_id: 'collision', label: { type: 'plain_text', text: 'What would you like Kit to do?' }, element: { type: 'static_select', action_id: 'value', options: choices.map(c => ({ value: c.decision, text: { type: 'plain_text', text: labels[c.decision] } })) } },
    ],
  }
}

export function collisionCard(row: UploadApproval): { text: string; blocks: KnownBlock[] } {
  const waiting = row.state === 'collision'
  const text = waiting ? `Upload paused — duplicate-name review needed for ${row.approved_name}` : `Duplicate-name review: ${row.state}. Filename: ${row.approved_name}`
  const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'plain_text', text: `${text}\n${waiting ? 'You approved this upload. Check the matching Frame file and choose Replace, Keep both, or Skip. Nothing uploads while this is unresolved.' : 'This request no longer needs a duplicate-name decision.'}` } }]
  if (waiting) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'kit_frame_collision_review', value: row.id, text: { type: 'plain_text', text: 'Resolve duplicate' }, style: 'primary' }] })
  return { text, blocks }
}
