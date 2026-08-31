/**
 * Kit Agent Definitions Index
 * 
 * Exports all agent definitions for registration with the Managed Agents API.
 * Import this in the registration script or deploy hook.
 */

import { productionMonitor } from './production-monitor'
import { callProcessor } from './call-processor'
import { slackParticipant } from './slack-participant'
import { sowGenerator } from './sow-generator'
import { workbackGenerator } from './workback-generator'
import { scriptWriter } from './script-writer'
import { storyboardBuilder } from './storyboard-builder'
import { deckBuilder } from './deck-builder'
import { scriptScopingAnalyzer } from './script-scoping-analyzer'
import type { KitAgentDefinition } from '@/lib/managed-agents/agent-registry'

export const ALL_AGENTS: KitAgentDefinition[] = [
  productionMonitor,
  callProcessor,
  slackParticipant,
  sowGenerator,
  workbackGenerator,
  scriptWriter,
  storyboardBuilder,
  deckBuilder,
  scriptScopingAnalyzer,
]

export {
  productionMonitor,
  callProcessor,
  slackParticipant,
  sowGenerator,
  workbackGenerator,
  scriptWriter,
  storyboardBuilder,
  deckBuilder,
  scriptScopingAnalyzer,
}

/** Agent keys for lookup */
export const AGENT_KEYS = {
  PRODUCTION_MONITOR: 'production-monitor',
  CALL_PROCESSOR: 'call-processor',
  SLACK_PARTICIPANT: 'slack-participant',
  SOW_GENERATOR: 'sow-generator',
  WORKBACK_GENERATOR: 'workback-generator',
  SCRIPT_WRITER: 'script-writer',
  STORYBOARD_BUILDER: 'storyboard-builder',
  DECK_BUILDER: 'deck-builder',
  SCRIPT_SCOPING_ANALYZER: 'script-scoping-analyzer',
} as const
