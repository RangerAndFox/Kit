import { describe, it, expect } from 'vitest'
import { buildOrchestratorTools, buildSpecialistTools } from '../src/llm/tools'
import { getAllAgents } from '../../src/lib/inngest/agents/registry'

describe('buildOrchestratorTools', () => {
  it('returns one tool per registered agent', () => {
    const tools = buildOrchestratorTools()
    const names = tools.map((t) => t.name).sort()
    // Derive from the registry so this doesn't go stale every time an
    // agent is added — what's under test is the ask_<id> mapping.
    const expected = getAllAgents().map((a) => `ask_${a.id}`).sort()
    expect(names).toEqual(expected)
    // Floor: the core four must be registered, so an empty registry can't pass.
    expect(names).toEqual(
      expect.arrayContaining(['ask_dropbox', 'ask_frameio', 'ask_harvest', 'ask_slack']),
    )
  })

  it('each tool takes a natural-language query string', () => {
    const tools = buildOrchestratorTools()
    const harvest = tools.find((t) => t.name === 'ask_harvest')!
    expect(harvest.input_schema.type).toBe('object')
    expect(harvest.input_schema.properties).toHaveProperty('query')
    expect(harvest.input_schema.required).toContain('query')
  })

  it('tool description includes agent expertise', () => {
    const tools = buildOrchestratorTools()
    const harvest = tools.find((t) => t.name === 'ask_harvest')!
    expect(harvest.description.toLowerCase()).toContain('harvest')
    expect(harvest.description.toLowerCase()).toMatch(/time|budget|project/)
  })
})

describe('buildSpecialistTools', () => {
  it('returns harvest action tools namespaced with harvest_ prefix', () => {
    const tools = buildSpecialistTools('harvest')
    const names = tools.map((t) => t.name)
    expect(names).toContain('harvest_log_time')
    expect(names).toContain('harvest_get_budget')
    expect(names).toContain('harvest_find_projects')
  })

  it('returns dropbox action tools namespaced with dropbox_ prefix', () => {
    const tools = buildSpecialistTools('dropbox')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((t) => t.name.startsWith('dropbox_'))).toBe(true)
  })

  it('throws on unknown agent', () => {
    expect(() => buildSpecialistTools('nonexistent')).toThrow()
  })

  it('tool description carries the capability description', () => {
    const tools = buildSpecialistTools('harvest')
    const logTime = tools.find((t) => t.name === 'harvest_log_time')!
    expect(logTime.description.toLowerCase()).toContain('log a time entry')
  })

  it('tool input_schema is a permissive object accepting any payload', () => {
    const tools = buildSpecialistTools('harvest')
    const logTime = tools.find((t) => t.name === 'harvest_log_time')!
    expect(logTime.input_schema.type).toBe('object')
    expect(JSON.stringify(logTime.input_schema)).toMatch(/project/i)
  })
})
