/** Operator-only exact-revision retirement. No public route or automatic sweep. */
import { createAdminClient } from '../supabase/admin'

export interface RetirementTarget {
  transferId: string
  projectId: string
  dropboxFileId: string
  dropboxRev: string
  expectedUpdatedAt: string
  expectedEventIds: string[]
}
export interface RetirementReceipt {
  transferId: string
  disposition: 'eligible' | 'retired' | 'already_retired'
  inboxEvents: number
}
export interface RetirementClient {
  retireAtomically(target: RetirementTarget, reason: string, actor: string, dryRun: boolean): Promise<RetirementReceipt>
}
export function retirementClient(): RetirementClient {
  return {
    async retireAtomically(t, reason, actor, dryRun) {
      const { data, error } = await createAdminClient().rpc('retire_frameio_transfer', {
        p_transfer_id: t.transferId, p_project_id: t.projectId,
        p_dropbox_file_id: t.dropboxFileId, p_dropbox_rev: t.dropboxRev,
        p_expected_updated_at: t.expectedUpdatedAt, p_expected_event_ids: t.expectedEventIds,
        p_reason: reason, p_actor: actor, p_dry_run: dryRun,
      })
      if (error) throw new Error('Retirement refused: ' + error.message)
      const receipt = data as unknown as RetirementReceipt
      if (!receipt || receipt.transferId !== t.transferId ||
        !['eligible','retired','already_retired'].includes(receipt.disposition)) throw new Error('Invalid retirement receipt')
      return receipt
    },
  }
}
export async function retireTransfers(client: RetirementClient, opts: {
  targets: RetirementTarget[]; reason: string; retiredBy: string; dryRun?: boolean
}): Promise<{ dryRun: boolean; receipts: RetirementReceipt[] }> {
  if (!opts.reason.trim() || !opts.retiredBy.trim()) throw new Error('Reason and actor required')
  const dryRun = opts.dryRun !== false
  const receipts: RetirementReceipt[] = []
  for (const target of opts.targets) {
    receipts.push(await client.retireAtomically(target, opts.reason, opts.retiredBy, dryRun))
  }
  // Each transfer+inbox+audit is atomic. Batch retries resume using receipts.
  return { dryRun, receipts }
}
