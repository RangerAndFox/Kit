import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { archiveFolderName, isArchiveTrigger, type ArchiveJob, type ArchiveProjectSnapshot } from './types'
import { archiveSettingsFromSlack, buildArchiveConfirmationCard, buildArchiveModal, buildArchiveProgressCard } from './blocks'
import { configuredArchiveDestinations } from './adapters'
import { derivativePlan } from './media-worker'

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
    const modal = buildArchiveModal({ snapshot, workspaceId: 'w1', channelId: 'D1', sourceVideoPath: '/delivery/final.mp4', destinations: ['dropbox', 'behance'] })
    assert.equal(modal.callback_id, 'kit_archive_project_submit')
    assert.match(modal.blocks[0].text.text, /drafts or unlisted/i)
    assert.equal(JSON.parse(modal.private_metadata).workspaceId, 'w1')
    assert.equal(modal.blocks.find((b: any) => b.block_id === 'source_video').element.initial_value, '/delivery/final.mp4')
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
})
