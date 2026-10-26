import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { parseInput, zodToJsonSchema } from './helpers'

test('Zod 4 MCP schemas preserve constraints, optional defaults, records and nullable inputs', () => {
  const schema = z.object({
    email: z.string().email().describe('Artist email'),
    count: z.number().int().min(1).max(10).default(1),
    mode: z.enum(['new', 'replace']),
    payload: z.record(z.string(), z.any()).optional(),
    note: z.string().nullable(),
  })
  const json = zodToJsonSchema(schema)
  assert.equal(json.type, 'object')
  assert.equal(json.additionalProperties, false)
  assert.deepEqual(json.required, ['email', 'mode', 'note'])
  const props = json.properties as Record<string, Record<string, unknown>>
  assert.equal(props.email.format, 'email')
  assert.equal(props.email.description, 'Artist email')
  assert.equal(props.count.type, 'integer')
  assert.equal(props.count.default, 1)
  assert.equal(props.count.minimum, 1)
  assert.deepEqual(props.mode.enum, ['new', 'replace'])
  assert.equal(props.payload.type, 'object')
  assert.ok(JSON.stringify(props.note).includes('null'))
  assert.deepEqual(parseInput(schema, { email: 'artist@example.com', mode: 'new', note: null }), {
    ok: true, value: { email: 'artist@example.com', count: 1, mode: 'new', note: null },
  })
  assert.equal(parseInput(schema, { email: 'not-email', mode: 'bad', note: null }).ok, false)
})

test('Zod 4 MCP dispatch publishes real schemas and rejects invalid or unscoped calls before handlers', async () => {
  const { handleRpc } = await import('./server')
  const names = ['kit_get_workspace_context', 'kit_list_projects', 'kit_get_project', 'kit_update_project',
    'kit_create_deliverables', 'kit_update_deliverable', 'kit_create_milestones', 'kit_update_milestone',
    'kit_list_team', 'kit_assign_project_access', 'kit_upsert_client_profile', 'kit_get_client_profile',
    'kit_create_action', 'kit_list_pending_actions', 'kit_create_action_breakdown', 'kit_save_workback_schedule',
    'kit_log_feedback', 'kit_log_time_entry', 'kit_sync_harvest_projects', 'kit_link_harvest_project', 'kit_list_agents', 'kit_ask_agent']
  const principal = { subject: 'test', workspaceId: '11111111-1111-4111-8111-111111111111', tools: names }
  const listed = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, principal)
  assert.ok(listed && 'result' in listed)
  const tools = (listed.result as { tools: Array<{ name: string; inputSchema: { type: string; properties: object } }> }).tools
  assert.equal(tools.length, names.length)
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    assert.ok(Object.keys(tool.inputSchema.properties).length, tool.name)
  }
  const invalid = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'kit_assign_project_access', arguments: { workspace_id: principal.workspaceId, project_id: 'bad-id' },
  } }, principal)
  assert.ok(invalid && 'result' in invalid)
  assert.equal((invalid.result as { isError: boolean }).isError, true)
  const unscoped = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'kit_get_project', arguments: { workspace_id: '22222222-2222-4222-8222-222222222222' },
  } }, principal)
  assert.ok(unscoped && 'result' in unscoped)
  assert.equal((unscoped.result as { isError: boolean }).isError, true)
})
