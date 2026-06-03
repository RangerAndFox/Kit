/**
 * Access-control unit tests — gateway rules + field-level scrub.
 *
 * Pure logic, no DB calls.
 *
 * Run: npx tsx --test src/lib/inngest/access-control.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkGateway,
  filterResultData,
  failsafeArtistContext,
  type UserContext,
} from './access-control'

const wsId = '00000000-0000-0000-0000-000000000000'

function admin(): UserContext {
  return {
    teamMemberId: 'm1',
    workspaceId: wsId,
    tier: 'admin',
    name: 'Steve',
    slackUserId: 'U_ADMIN',
    projectFinancials: new Set(),
  }
}

function producer(financialFor: string[] = []): UserContext {
  return {
    teamMemberId: 'm2',
    workspaceId: wsId,
    tier: 'producer',
    name: 'Brad',
    slackUserId: 'U_PRODUCER',
    projectFinancials: new Set(financialFor),
  }
}

function artist(): UserContext {
  return {
    teamMemberId: 'm3',
    workspaceId: wsId,
    tier: 'artist',
    name: 'Priya',
    slackUserId: 'U_ARTIST',
    projectFinancials: new Set(),
  }
}

describe('checkGateway — brain', () => {
  it('blocks every brain action for artists', () => {
    for (const action of ['get', 'seed', 'why', 'refresh_canvas']) {
      const r = checkGateway(artist(), 'brain', action)
      assert.equal(r.allowed, false, `brain:${action} should be blocked`)
    }
  })

  it('allows brain actions for producers', () => {
    for (const action of ['get', 'seed', 'why', 'refresh_canvas']) {
      const r = checkGateway(producer(), 'brain', action)
      assert.equal(r.allowed, true)
    }
  })

  it('allows brain actions for admins', () => {
    assert.equal(checkGateway(admin(), 'brain', 'get').allowed, true)
  })
})

describe('checkGateway — studio_knowledge', () => {
  it('blocks search / lookup_project / find_contact for artists', () => {
    for (const action of ['search', 'lookup_project', 'lookup_client', 'find_contact', 'recent_projects', 'recent_clients']) {
      assert.equal(checkGateway(artist(), 'studio_knowledge', action).allowed, false, `studio_knowledge:${action}`)
    }
  })

  it('allows the same actions for producers', () => {
    for (const action of ['search', 'lookup_project', 'lookup_client', 'find_contact', 'recent_projects', 'recent_clients']) {
      assert.equal(checkGateway(producer(), 'studio_knowledge', action).allowed, true)
    }
  })

  it('reembed actions are admin-only', () => {
    assert.equal(checkGateway(producer(), 'studio_knowledge', 'reembed_all').allowed, false)
    assert.equal(checkGateway(admin(), 'studio_knowledge', 'reembed_all').allowed, true)
  })
})

describe('checkGateway — harvest', () => {
  it('artists can log time + find projects + see project tasks', () => {
    assert.equal(checkGateway(artist(), 'harvest', 'log_time').allowed, true)
    assert.equal(checkGateway(artist(), 'harvest', 'find_projects').allowed, true)
    assert.equal(checkGateway(artist(), 'harvest', 'get_project_tasks').allowed, true)
  })

  it('artists CANNOT see budgets, time entries, summaries, contacts', () => {
    assert.equal(checkGateway(artist(), 'harvest', 'get_budget', 'proj-x').allowed, false)
    assert.equal(checkGateway(artist(), 'harvest', 'get_time_entries').allowed, false)
    assert.equal(checkGateway(artist(), 'harvest', 'get_summary').allowed, false)
    assert.equal(checkGateway(artist(), 'harvest', 'get_contacts').allowed, false)
    assert.equal(checkGateway(artist(), 'harvest', 'get_team').allowed, false)
  })

  it('budget requires producer + per-project financial flag', () => {
    assert.equal(checkGateway(producer(), 'harvest', 'get_budget', 'proj-x').allowed, false)
    assert.equal(checkGateway(producer(['proj-x']), 'harvest', 'get_budget', 'proj-x').allowed, true)
    assert.equal(checkGateway(admin(), 'harvest', 'get_budget', 'proj-x').allowed, true)
  })
})

describe('filterResultData — artist receives a name-only project record', () => {
  const fullProject = {
    id: 'p-1',
    name: 'Sizzle',
    project_code: '2699',
    harvest_project_id: 12345,
    status: 'active',
    // Producer fields — should be stripped
    client: 'Foot Locker',
    client_name: 'Foot Locker',
    client_email: 'pm@footlocker.com',
    primary_contacts: [{ first_name: 'Sam', email: 'sam@footlocker.com' }],
    budget_total: 50000,
    budget_spent: 12000,
    start_date: '2026-05-01',
    target_delivery: '2026-06-22',
    brief_summary: 'Hero sizzle for the new launch.',
    external_links: { dropbox: 'https://...' },
    // Admin-only — also stripped
    margin_target: 0.4,
    sow_summary: 'Detailed scope here.',
  }

  it('strips client / dates / brief / budget / contacts for artists', () => {
    const filtered = filterResultData(fullProject, artist())!
    assert.ok(!('client' in filtered))
    assert.ok(!('client_email' in filtered))
    assert.ok(!('primary_contacts' in filtered))
    assert.ok(!('budget_total' in filtered))
    assert.ok(!('start_date' in filtered))
    assert.ok(!('target_delivery' in filtered))
    assert.ok(!('brief_summary' in filtered))
    assert.ok(!('external_links' in filtered))
    assert.ok(!('margin_target' in filtered))
    assert.ok(!('sow_summary' in filtered))
    // Whitelist survivors
    assert.equal(filtered.name, 'Sizzle')
    assert.equal(filtered.project_code, '2699')
    assert.equal(filtered.harvest_project_id, 12345)
    assert.equal(filtered.status, 'active')
    assert.equal(filtered.id, 'p-1')
  })

  it('leaves producer field-set intact for producers (sans admin-only)', () => {
    const filtered = filterResultData(fullProject, producer())!
    assert.equal(filtered.client, 'Foot Locker')
    assert.equal(filtered.budget_total, 50000)
    assert.equal(filtered.brief_summary, 'Hero sizzle for the new launch.')
    // Admin-only fields stripped
    assert.ok(!('margin_target' in filtered))
    assert.ok(!('sow_summary' in filtered))
  })

  it('admins see everything', () => {
    const filtered = filterResultData(fullProject, admin())!
    assert.deepEqual(filtered, fullProject)
  })

  it('recursively strips inside arrays (e.g. find_projects results)', () => {
    const list = { projects: [fullProject, { ...fullProject, id: 'p-2' }] }
    const filtered = filterResultData(list, artist())!
    const projects = filtered.projects as any[]
    assert.equal(projects.length, 2)
    for (const p of projects) {
      assert.ok(!('client' in p))
      assert.ok(!('budget_total' in p))
      assert.equal(p.name, 'Sizzle')
    }
  })
})

describe('failsafeArtistContext', () => {
  it('returns an artist-tier UserContext for an unknown slack user', () => {
    const ctx = failsafeArtistContext(wsId, 'U_UNKNOWN')
    assert.equal(ctx.tier, 'artist')
    assert.equal(ctx.slackUserId, 'U_UNKNOWN')
    assert.equal(ctx.workspaceId, wsId)
  })
})
