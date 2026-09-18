import { describe, expect, it } from 'vitest'
import { deliveryProjectNumber, selectDeliveryProject, selectDeliveryProducer } from '../../src/lib/projects/delivery-routing'

describe('delivery project identity', () => {
  const project = { id: 'canonical', project_code: '2638-Microsoft', external_ids: { project_number: '2638' } }
  it('reuses the original record after a folder/project rename, even without a saved folder name', () => {
    expect(selectDeliveryProject([project], '2638_Microsoft_MSFT_Customer_Service_Demo')).toBe(project)
  })
  it('never guesses between duplicates, even when one has the exact folder label', () => {
    expect(() => selectDeliveryProject([project, { ...project, id: 'duplicate', external_ids: { project_number: '2638' } }], '2638_New_Name')).toThrow(/ambiguous/)
  })
  it('ignores explicitly merged audit records', () => {
    expect(selectDeliveryProject([project, { ...project, id: 'old', external_ids: { project_number: '2638', merged_into_project_id: project.id } }], '2638_Name')).toBe(project)
  })
  it('does not silently create unknown projects', () => {
    expect(() => selectDeliveryProject([], '2644_Name')).toThrow(/not provisioned/)
  })
  it('preserves suffixes and exact boundaries', () => {
    expect(deliveryProjectNumber('2630a_Internal')).toBe('2630A')
    expect(() => selectDeliveryProject([project], '26380_Name')).toThrow(/not provisioned/)
    expect(() => selectDeliveryProject([project], '2638A_Name')).toThrow(/not provisioned/)
    expect(deliveryProjectNumber('2638bad')).toBeNull()
  })
})

describe('private producer routing', () => {
  const staff = [
    { full_name: 'Jennifer', slack_user_id: 'UJENNIFER', role: 'producer', is_active: true },
    { full_name: 'Allyson', slack_user_id: 'UALLY', role: 'producer', is_active: true },
    { full_name: 'Jared Doud', slack_user_id: 'UJARED', role: 'admin', is_active: true },
  ]
  it('resolves the authoritative Sheet producer rather than stale provisioning ownership', () => {
    expect(selectDeliveryProducer('Jennifer', staff)).toBe('UJENNIFER')
    expect(selectDeliveryProducer(' Ally ', staff)).toBe('UALLY')
    expect(selectDeliveryProducer('Jared', staff)).toBe('UJARED')
    expect(selectDeliveryProducer('UJENNIFER', staff)).toBe('UJENNIFER')
  })
  it('fails visibly for a missing or ambiguous recipient', () => {
    expect(() => selectDeliveryProducer('', staff)).toThrow(/missing/)
    expect(() => selectDeliveryProducer('Jen', staff)).toThrow(/missing/)
    expect(() => selectDeliveryProducer('Jennifer', [...staff, { ...staff[0], slack_user_id: 'UOTHER' }])).toThrow(/ambiguous/)
  })
  it('never routes to an artist or inactive producer', () => {
    expect(() => selectDeliveryProducer('Jennifer', [{ ...staff[0], role: 'artist' }])).toThrow()
    expect(() => selectDeliveryProducer('Jennifer', [{ ...staff[0], is_active: false }])).toThrow()
  })
})
