/**
 * Tests for computeUpdatePlan: field-level diff, derived-string recompute, and
 * the service side-effect flags.
 *
 * Run: npx tsx --test src/lib/provisioner/update-diff.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeUpdatePlan, type ProjectSnapshot, type UpdateForm } from './update-diff'

const BASE: ProjectSnapshot = {
  projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  projectNumber: '2601',
  clientName: 'Nike',
  clientContact: 'Jane Doe',
  projectName: 'Summer Campaign',
  projectType: 'Brand Video',
  projectManagerSlackId: 'U_PROD',
  creativeDirectorSlackId: 'U_CD',
  startDate: '2026-01-01',
  targetDelivery: '2026-03-01',
  briefSummary: 'A summer brand push.',
}

function formFrom(s: ProjectSnapshot, overrides: Partial<UpdateForm> = {}): UpdateForm {
  return {
    projectNumber: s.projectNumber,
    clientName: s.clientName,
    clientContact: s.clientContact ?? undefined,
    projectName: s.projectName,
    projectType: s.projectType ?? undefined,
    projectManager: s.projectManagerSlackId ?? undefined,
    creativeDirector: s.creativeDirectorSlackId ?? undefined,
    startDate: s.startDate ?? undefined,
    deadline: s.targetDelivery ?? undefined,
    description: s.briefSummary ?? undefined,
    ...overrides,
  }
}

describe('computeUpdatePlan — no changes', () => {
  it('detects an identical form as no-op', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE))
    assert.equal(plan.hasChanges, false)
    assert.equal(plan.changes.length, 0)
    assert.equal(plan.identityChanged, false)
    assert.deepEqual(plan.services, {
      slack: false, frameio: false, harvest: false, dropbox: false, sheet: false, supabase: false,
    })
  })

  it('treats whitespace-only differences as no change', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { projectName: '  Summer Campaign  ' }))
    assert.equal(plan.hasChanges, false)
  })
})

describe('computeUpdatePlan — non-identity scalar change', () => {
  it('description-only change ripples to supabase only', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { description: 'Reworked brief.' }))
    assert.equal(plan.hasChanges, true)
    assert.equal(plan.identityChanged, false)
    assert.deepEqual(plan.changes.map((c) => c.field), ['description'])
    assert.deepEqual(plan.services, {
      slack: false, frameio: false, harvest: false, dropbox: false, sheet: false, supabase: true,
    })
    assert.deepEqual(plan.derived, {})
  })

  it('client contact change ripples to sheet + supabase, no external renames', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { clientContact: 'John Roe' }))
    assert.equal(plan.identityChanged, false)
    assert.equal(plan.services.sheet, true)
    assert.equal(plan.services.supabase, true)
    assert.equal(plan.services.slack, false)
    assert.equal(plan.services.dropbox, false)
    assert.equal(plan.services.frameio, false)
    assert.equal(plan.services.harvest, false)
  })

  it('a blank project_type (NULL/legacy type, no canonical match) is NOT a change', () => {
    // Harvest-synced project: stored type is NULL/non-canonical, so the modal
    // shows no pre-selection and an optional blank comes back. A blank must never
    // diff as a clear-to-null while the user edits an unrelated field.
    const legacy: ProjectSnapshot = { ...BASE, projectType: 'Sizzle Reel' }
    const plan = computeUpdatePlan(legacy, formFrom(legacy, { projectType: undefined, deadline: '2026-04-01' }))
    assert.deepEqual(plan.changes.map((c) => c.field), ['deadline'])
    assert.equal(plan.changes.some((c) => c.field === 'project_type'), false)
  })

  it('picking a real project_type still flags it as a change', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { projectType: 'Explainer' }))
    assert.deepEqual(plan.changes.map((c) => c.field), ['project_type'])
    assert.equal(plan.services.supabase, true)
  })

  it('a blank client is a no-op (never a clear) — clearing it would wedge the Slack rename', () => {
    // client_name is optional only so a Harvest-synced null-client project stays
    // submittable; blanking it on a provisioned project must NOT ripple an empty
    // client to Slack (which hard-fails on empty client and re-fails forever).
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { clientName: '', deadline: '2026-04-01' }))
    assert.deepEqual(plan.changes.map((c) => c.field), ['deadline'])
    assert.equal(plan.changes.some((c) => c.field === 'client'), false)
    assert.equal(plan.services.slack, false)
  })

  it('changing the client to a new value still ripples', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { clientName: 'Adidas' }))
    assert.equal(plan.changes.some((c) => c.field === 'client'), true)
    assert.equal(plan.identityChanged, true)
  })

  it('a whitespace-only client rename still ripples to Harvest (projectCode collapses whitespace)', () => {
    // deriveProjectCode strips internal whitespace, so 'Coca Cola' → 'CocaCola'
    // yields an identical projectCode; the Harvest gate must still catch it via the
    // raw clientChanged flag, like every other outlet does.
    const cc = { ...BASE, clientName: 'Coca Cola' }
    const plan = computeUpdatePlan(cc, formFrom(cc, { clientName: 'CocaCola' }))
    assert.equal(plan.changes.some((c) => c.field === 'client'), true)
    assert.equal(plan.derived.projectCode, undefined) // projectCode identical on both sides
    assert.equal(plan.services.harvest, true) // …yet Harvest still ripples
  })

  it('producer change is a user field and ripples to sheet + supabase', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { projectManager: 'U_NEWPROD' }))
    const change = plan.changes.find((c) => c.field === 'project_manager')
    assert.ok(change)
    assert.equal(change!.isUser, true)
    assert.equal(change!.old, 'U_PROD')
    assert.equal(change!.new, 'U_NEWPROD')
    assert.equal(plan.services.sheet, true)
    assert.equal(plan.services.supabase, true)
    assert.equal(plan.services.slack, false)
  })
})

describe('computeUpdatePlan — project name change', () => {
  it('ripples to dropbox, frameio, harvest, slack, sheet, supabase', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { projectName: 'Winter Campaign' }))
    assert.equal(plan.identityChanged, true)
    assert.deepEqual(plan.services, {
      slack: true, frameio: true, harvest: true, dropbox: true, sheet: true, supabase: true,
    })
    assert.ok(plan.derived.dropboxSafeName)
    assert.ok(plan.derived.frameioBusinessLabel)
    assert.ok(plan.derived.slackSlug)
    // Project code is number-client only, so a name-only change leaves it fixed.
    assert.equal(plan.derived.projectCode, undefined)
  })
})

describe('computeUpdatePlan — client change', () => {
  it('changes the project code and ripples everywhere', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { clientName: 'Adidas' }))
    assert.equal(plan.identityChanged, true)
    assert.ok(plan.derived.projectCode)
    assert.equal(plan.derived.projectCode!.old, '2601-Nike')
    assert.equal(plan.derived.projectCode!.new, '2601-Adidas')
    assert.ok(plan.derived.dropboxSafeName)
    assert.equal(plan.derived.dropboxSafeName!.new, '2601_Adidas_Summer Campaign'.replace(/\s+/g, '_'))
    assert.deepEqual(plan.services, {
      slack: true, frameio: true, harvest: true, dropbox: true, sheet: true, supabase: true,
    })
  })
})

describe('computeUpdatePlan — project number change', () => {
  it('changes code + dropbox + frameio + slug; harvest via code', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { projectNumber: '2602' }))
    assert.equal(plan.identityChanged, true)
    assert.ok(plan.derived.projectCode)
    assert.equal(plan.derived.projectCode!.new, '2602-Nike')
    assert.equal(plan.services.harvest, true) // via projectCode change
    assert.equal(plan.services.dropbox, true)
    assert.equal(plan.services.frameio, true)
    assert.equal(plan.services.slack, true)
  })
})

describe('computeUpdatePlan — provisioned-service gating', () => {
  it('never flags a service the project was created without', () => {
    // Project has no Frame.io / Dropbox; a client change would otherwise ripple to all.
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { clientName: 'Adidas' }), {
      slack: true, harvest: true, frameio: false, dropbox: false,
    })
    assert.equal(plan.identityChanged, true)
    assert.equal(plan.services.frameio, false) // not provisioned → never required
    assert.equal(plan.services.dropbox, false)
    assert.equal(plan.services.slack, true)
    assert.equal(plan.services.harvest, true)
    // The derived strings still move — gating is independent of the diff itself.
    assert.ok(plan.derived.dropboxSafeName)
  })

  it('defaults every service present when provisioning is unknown', () => {
    const plan = computeUpdatePlan(BASE, formFrom(BASE, { clientName: 'Adidas' }))
    assert.deepEqual(plan.services, {
      slack: true, frameio: true, harvest: true, dropbox: true, sheet: true, supabase: true,
    })
  })
})

describe('computeUpdatePlan — multiple simultaneous changes', () => {
  it('collects every changed field in order', () => {
    const plan = computeUpdatePlan(
      BASE,
      formFrom(BASE, { clientName: 'Adidas', deadline: '2026-04-01', description: 'New brief.' }),
    )
    assert.deepEqual(plan.changes.map((c) => c.field), ['client', 'deadline', 'description'])
    assert.equal(plan.identityChanged, true)
  })
})
