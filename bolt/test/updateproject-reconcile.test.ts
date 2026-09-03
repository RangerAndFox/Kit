import { describe, expect, it } from 'vitest'
import {
  detectSlackIdentityDrift,
  parseSlackProjectChannel,
  reconcileProjectPicker,
} from '../src/handlers/updateproject-reconcile'

describe('live Slack project reconciliation', () => {
  const live2637 = parseSlackProjectChannel({
    id: 'C2637',
    name: '2637-microsoft-microsoft-fabric-iq-sizzle-video-undefined',
    creator: 'UKIT',
    purpose: { value: 'Microsoft — Microsoft Fabric IQ sizzle video [kit:undefined]' },
    topic: { value: 'Microsoft — Microsoft Fabric IQ sizzle video' },
  }, 'UKIT')!

  it('recognizes legacy Kit channels and uses topic data instead of the undefined slug tail', () => {
    expect(live2637).toMatchObject({
      projectNumber: '2637',
      client: 'Microsoft',
      projectName: 'Microsoft Fabric IQ sizzle video',
      label: '2637 — Microsoft — Microsoft Fabric IQ sizzle video',
    })
  })

  it('rejects archived and unrelated number-prefixed channels', () => {
    expect(parseSlackProjectChannel({ id: 'C1', name: '2637-random', is_archived: true }, 'UKIT')).toBeNull()
    expect(parseSlackProjectChannel({ id: 'C2', name: '2637-random', creator: 'UOTHER' }, 'UKIT')).toBeNull()
    expect(parseSlackProjectChannel({
      id: 'C3',
      name: '2637-forged',
      creator: 'UOTHER',
      purpose: { value: 'Microsoft — Forged [kit:undefined]' },
    }, 'UKIT')).toBeNull()
  })

  it('excludes stale database rows and offers live channels missing from the database', () => {
    const options = reconcileProjectPicker([
      {
        id: 'db-7777',
        project_code: '7777-Nike',
        client: 'Nike',
        name: 'Socks',
        external_links: { slack_id: 'CDELETED' },
      },
    ], [live2637])

    expect(options).toEqual([
      { id: 'slack:C2637', label: '2637 — Microsoft — Microsoft Fabric IQ sizzle video' },
    ])
  })

  it('keeps directly-linked live projects as normal database options', () => {
    const options = reconcileProjectPicker([
      {
        id: 'db-2637',
        project_code: '2637-Microsoft',
        client: 'Microsoft',
        name: 'Fabric IQ',
        external_links: { slack_id: 'C2637' },
      },
    ], [live2637])

    expect(options).toEqual([
      { id: 'db-2637', label: '2637 — Microsoft — Fabric IQ' },
    ])
  })

  it('uses adoption to backfill a row that matches by number but lacks its Slack link', () => {
    const options = reconcileProjectPicker([
      {
        id: 'db-2637',
        project_code: '2637-Microsoft',
        client: 'Microsoft',
        name: 'Fabric IQ',
        external_links: {},
      },
    ], [live2637])

    expect(options[0].id).toBe('slack:C2637')
  })

  it('detects a manually renamed channel so an unchanged update can repair it', () => {
    expect(detectSlackIdentityDrift({
      id: 'C2638',
      name: '2638-msft-2638-msft-customer-service-sizzle',
    }, {
      projectId: '31c306e9-53c1-4278-923f-a7135d9507a0',
      projectNumber: '2638',
      client: 'Microsoft',
      projectName: 'D365 Customer Service Sizzle',
    })).toEqual({
      currentName: '2638-msft-2638-msft-customer-service-sizzle',
      expectedName: '2638-microsoft-d365-customer-service-sizzle',
    })
  })

  it('accepts both the normal and deterministic collision slugs as synced', () => {
    const expected = {
      projectId: '31c306e9-53c1-4278-923f-a7135d9507a0',
      projectNumber: '2638',
      client: 'Microsoft',
      projectName: 'D365 Customer Service Sizzle',
    }
    expect(detectSlackIdentityDrift({ id: 'C1', name: '2638-microsoft-d365-customer-service-sizzle' }, expected)).toBeNull()
    expect(detectSlackIdentityDrift({ id: 'C1', name: '2638-microsoft-d365-customer-service-sizzle-31c306e9' }, expected)).toBeNull()
  })
})
