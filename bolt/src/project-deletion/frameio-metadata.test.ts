import { expect, test } from 'vitest'
import { frameioProjectIdFromMetadata } from './handlers'

test('Frame.io deletion id resolves from direct metadata before URLs', () => {
  const directId = '67fe1867-0053-4150-8d46-472e2bdbd443'
  expect(frameioProjectIdFromMetadata(
    { frameio_id: directId },
    { frameio_project_id: '8936d719-535b-4215-ba6d-fa58dbe7c499' },
  )).toBe(directId)
})

test('Frame.io deletion ignores malformed direct metadata and falls back to a canonical URL', () => {
  expect(frameioProjectIdFromMetadata(
    { frameio_id: 'not-a-project-id', frameio: 'https://next.frame.io/project/8936d719-535b-4215-ba6d-fa58dbe7c499' },
    {},
  )).toBe('8936d719-535b-4215-ba6d-fa58dbe7c499')
})

test('Frame.io deletion id resolves from the canonical project URL', () => {
  expect(
    frameioProjectIdFromMetadata({ frameio: 'https://next.frame.io/project/8936d719-535b-4215-ba6d-fa58dbe7c499' }, {}),
  ).toBe('8936d719-535b-4215-ba6d-fa58dbe7c499')
})
