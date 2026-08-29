import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { archiveFolderName, isArchiveTrigger, type ArchiveJob, type ArchiveProjectSnapshot } from './types'
import { archiveSettingsFromSlack, buildArchiveConfirmationCard, buildArchiveLoadingErrorModal, buildArchiveLoadingModal, buildArchiveModal, buildArchiveProgressCard } from './blocks'
import { configuredArchiveDestinations } from './adapters'
import { derivativePlan } from './media-worker'
import { normalizeArchiveCopyDraft, publicSafeContext } from './draft'

const snapshot: ArchiveProjectSnapshot = {
  projectId: 'p1', projectNumber: '2637', client: 'Ranger & Fox', projectName: 'Fabric IQ / Sizzle',
  dropboxProjectPath: '/production/2026/2637_Microsoft_Fabric',
}

describe('archive publisher Slack surface', () => {
  it('matches only short explicit archive/publish commands', () => {
    assert.equal(isArchiveTrigger('archive project'), true)
    assert.equal(isArchiveTrigger('/publish project'), true)
    assert.equal(isArchiveTrigger('archive this project and publish it publicly'), false)
  })

  it('derives a deterministic safe archive folder name', () => {
    assert.equal(archiveFolderName(snapshot), '2637_Ranger_Fox_Fabric_IQ_Sizzle')
  })

  it('keeps unavailable external destinations out of the modal', () => {
    assert.deepEqual(configuredArchiveDestinations({}), ['dropbox', 'behance'])
    assert.deepEqual(configuredArchiveDestinations({ VIMEO_ACCESS_TOKEN: 'x' }), ['dropbox', 'vimeo', 'behance'])
    assert.deepEqual(configuredArchiveDestinations({ KIT_ARCHIVE_DESTINATIONS: 'dropbox, vimeo, wordpress, nope' }), ['dropbox', 'vimeo', 'wordpress'])
  })

  it('caps derivative generation for long videos and distributes GIF clips', () => {
    const long = derivativePlan(600)
    assert.equal(long.stillInterval, 4)
    assert.equal(long.gifStarts.length, 8)
    assert.equal(long.gifStarts[0], 0)
    assert.equal(long.gifStarts.at(-1), 594)
    assert.deepEqual(derivativePlan(2).gifStarts, [])
  })

  it('builds a prefilled, draft-only modal', () => {
    const modal = buildArchiveModal({ snapshot, workspaceId: 'w1', channelId: 'D1', sourceVideoPath: '/delivery/final.mp4', destinations: ['dropbox', 'behance'], draft: { subtitle: 'A launch film', services: ['Design', 'Animation'], socialCopy: 'We made a thing.' } })
    assert.equal(modal.callback_id, 'kit_archive_project_submit')
    assert.match(modal.blocks[0].text.text, /drafts or unlisted/i)
    assert.equal(JSON.parse(modal.private_metadata).workspaceId, 'w1')
    assert.equal(modal.blocks.find((b: any) => b.block_id === 'source_video').element.initial_value, '/delivery/final.mp4')
    assert.equal(modal.blocks.find((b: any) => b.block_id === 'subtitle').element.initial_value, 'A launch film')
    assert.equal(modal.blocks.find((b: any) => b.block_id === 'services').element.initial_value, 'Design, Animation')
  })

  it('opens a safe loading modal while Kit drafts copy', () => {
    const modal = buildArchiveLoadingModal('p1', 'D1')
    assert.equal(modal.callback_id, 'kit_archive_loading')
    assert.match(modal.blocks[1].elements[0].text, /Financial, contact, legal, credential/i)
  })

  it('turns loading failures into a visible modal instead of leaving a spinner', () => {
    const modal = buildArchiveLoadingErrorModal('p1', 'D1', 'No project context')
    assert.equal(modal.callback_id, 'kit_archive_loading_error')
    assert.match(modal.blocks[0].text.text, /No project context/)
  })

  it('removes sensitive lines before public-copy drafting', () => {
    const safe = publicSafeContext('Great animation work.\nBudget: $50,000\nContact jane@example.com\nPassword: secret\nBeautiful visual system.')
    assert.equal(safe, 'Great animation work.\nBeautiful visual system.')
  })

  it('normalizes generated copy and falls back when fields are missing', () => {
    const fallback = { title: 'Fallback', subtitle: '', services: [], description1: 'Intro', description2: '', description3: '', credits: '', socialCopy: 'Post', excerpt: 'Short' }
    const draft = normalizeArchiveCopyDraft({ title: 'Draft', services: ['Design', 'Design'], description1: '' }, fallback)
    assert.equal(draft.title, 'Draft')
    assert.deepEqual(draft.services, ['Design'])
    assert.equal(draft.description1, 'Intro')
  })

  it('requires rights confirmation in parsed settings', () => {
    const values = {
      source_video: { val: { value: '/x/final.mp4' } }, title: { val: { value: 'Title' } },
      year: { val: { value: '2026' } }, destinations: { val: { selected_options: [{ value: 'dropbox' }] } },
      rights: { val: { selected_options: [] } },
    }
    const parsed = archiveSettingsFromSlack(values)
    assert.equal(parsed.settings.rightsConfirmed, false)
    assert.deepEqual(parsed.destinations, ['dropbox'])
  })

  it('never offers a public publish button', () => {
    const job = {
      id: 'j1', workspace_id: 'w1', project_id: 'p1', requested_by_slack_user_id: 'U1', status: 'awaiting_confirmation',
      source_video_path: '/x/final.mp4', project_snapshot: snapshot,
      settings: { title: 'Title', subtitle: '', year: '2026', services: [], description1: '', description2: '', description3: '', credits: '', socialCopy: '', excerpt: '', backgroundColor: '#000', includeProcess: false, rightsConfirmed: true },
      destinations: ['dropbox', 'behance'], progress: {}, results: {}, error: null, slack_channel_id: 'D1', slack_message_ts: '1', idempotency_key: 'k', attempt: 0, created_at: '', updated_at: '',
    } as ArchiveJob
    const confirmation = buildArchiveConfirmationCard(job)
    const labels = confirmation.blocks.flatMap((block: any) => block.elements || []).map((element: any) => element.text?.text)
    assert.ok(labels.includes('Start archive'))
    assert.ok(!labels.some((label: string) => /publish publicly/i.test(label || '')))
    const progress = buildArchiveProgressCard({ ...job, status: 'complete' })
    assert.match(progress.blocks.at(-1).elements[0].text, /Review each destination before publishing/)
  })

  it('offers an explicit draft action only after the Behance package is ready', () => {
    const job = {
      id: 'j1', workspace_id: 'w1', project_id: 'p1', requested_by_slack_user_id: 'U1', status: 'complete',
      source_video_path: '/x/final.mp4', project_snapshot: snapshot,
      settings: { title: 'Title', subtitle: '', year: '2026', services: [], description1: '', description2: '', description3: '', credits: '', socialCopy: '', excerpt: '', backgroundColor: '#000', includeProcess: false, rightsConfirmed: true },
      destinations: ['dropbox', 'behance'], progress: {}, results: { behance: { status: 'ready', title: 'Title' } }, error: null,
      slack_channel_id: 'D1', slack_message_ts: '1', idempotency_key: 'k', attempt: 1, created_at: '', updated_at: '',
    } as ArchiveJob
    const card = buildArchiveProgressCard(job)
    const buttons = card.blocks.flatMap((block: any) => block.elements || [])
    assert.ok(buttons.some((button: any) => button.action_id === 'kit_behance_create_draft'))
    assert.ok(!buttons.some((button: any) => /publish/i.test(button.text?.text || '')))
  })
})
