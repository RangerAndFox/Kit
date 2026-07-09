// @ts-nocheck
/**
 * Kit MCP Server
 *
 * Implements MCP (Model Context Protocol) JSON-RPC 2.0 methods directly
 * over HTTP. We skip the SDK transport layer because we're running
 * stateless serverless — every request is self-contained.
 *
 * Supported MCP methods:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - ping
 */

import { z } from 'zod'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  KitTool,
  ToolCallResult,
} from './types'
import { RPC_ERRORS } from './types'
import { zodToJsonSchema, parseInput } from './helpers'

// ─── Tool registry ───────────────────────────────────────────

import { getWorkspaceContext } from './tools/workspace'
import { listProjects, getProject, updateProject } from './tools/projects'
import { createDeliverables, updateDeliverable } from './tools/deliverables'
import { createMilestones, updateMilestone } from './tools/milestones'
import { listTeam, assignProjectAccess } from './tools/team'
import { upsertClientProfile, getClientProfile } from './tools/clients'
import { createAction, listPendingActions, createActionBreakdown } from './tools/actions'
import { saveWorkbackSchedule } from './tools/workback'
import { logFeedback, logTimeEntry } from './tools/feedback'
import { syncHarvestProjects, linkHarvestProject } from './tools/harvest'
import { listAgents, askAgent } from './tools/agents'

const tools: KitTool[] = [
  // Context
  getWorkspaceContext,
  // Projects
  listProjects,
  getProject,
  updateProject,
  // Project entities
  createDeliverables,
  updateDeliverable,
  createMilestones,
  updateMilestone,
  // Team
  listTeam,
  assignProjectAccess,
  // Clients
  upsertClientProfile,
  getClientProfile,
  // Kit actions
  createAction,
  listPendingActions,
  createActionBreakdown,
  // Workback
  saveWorkbackSchedule,
  // Feedback + time
  logFeedback,
  logTimeEntry,
  // Harvest
  syncHarvestProjects,
  linkHarvestProject,
  // Agent system
  listAgents,
  askAgent,
]

const toolsByName = new Map(tools.map((t) => [t.name, t]))

// ─── MCP method implementations ──────────────────────────────

const PROTOCOL_VERSION = '2025-06-18'

function initialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: {
      name: 'kit-mcp',
      version: '1.0.0',
    },
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    instructions:
      'Kit MCP exposes tools for managing a creative-studio workspace: projects, deliverables, milestones, team, clients, feedback, and kit_actions. ALWAYS start by calling kit_get_workspace_context to resolve workspace_id — every other tool requires it.',
  }
}

function listTools() {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
      annotations: t.annotations,
    })),
  }
}

const CallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.any()).optional().default({}),
})

async function callTool(params: unknown): Promise<ToolCallResult> {
  const parsed = CallParamsSchema.safeParse(params)
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `Invalid tools/call params: ${parsed.error.message}` }],
      isError: true,
    }
  }

  const tool = toolsByName.get(parsed.data.name)
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${parsed.data.name}` }],
      isError: true,
    }
  }

  const input = parseInput(tool.schema, parsed.data.arguments)
  if (!input.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid arguments for ${tool.name}: ${JSON.stringify(input.issues, null, 2)}`,
        },
      ],
      isError: true,
    }
  }

  try {
    return await tool.handler(input.value)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Tool ${tool.name} threw: ${message}` }],
      isError: true,
    }
  }
}

// ─── JSON-RPC dispatcher ─────────────────────────────────────

function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

export async function handleRpc(body: unknown): Promise<JsonRpcResponse | null> {
  if (!body || typeof body !== 'object') {
    return errorResponse(null, RPC_ERRORS.INVALID_REQUEST, 'Request must be a JSON object')
  }
  const req = body as JsonRpcRequest
  const id = req.id ?? null

  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return errorResponse(id, RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request')
  }

  // Notifications (no id) don't require a response
  const isNotification = req.id === undefined || req.id === null

  try {
    switch (req.method) {
      case 'initialize':
        return success(id, initialize())

      case 'initialized':
      case 'notifications/initialized':
        return isNotification ? null : success(id, {})

      case 'ping':
        return success(id, {})

      case 'tools/list':
        return success(id, listTools())

      case 'tools/call': {
        const result = await callTool(req.params)
        return success(id, result)
      }

      // Methods we don't implement yet — respond gracefully
      case 'resources/list':
        return success(id, { resources: [] })
      case 'prompts/list':
        return success(id, { prompts: [] })

      default:
        return errorResponse(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${req.method}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return errorResponse(id, RPC_ERRORS.INTERNAL_ERROR, message)
  }
}
