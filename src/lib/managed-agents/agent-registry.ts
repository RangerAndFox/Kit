/**
 * Agent Registry
 *
 * Registers Kit's agent definitions with the Managed Agents API.
 */

import { getManagedAgentsClient, type AgentConfig, type AgentResponse } from './client'
import { createAdminClient } from '@/lib/supabase/admin'

function enrichAgentConfig(config: AgentConfig): AgentConfig {
  // Never export Kit's privileged database tool surface to an external
  // managed-agent runtime. The legacy configuration embedded one shared
  // secret in the URL. A future reintroduction must use a dedicated identity
  // provider plus per-agent workspace/tool claims and revocation.
  const others = (config.mcp_servers || []).filter((s) => s.name !== 'kit')
  const existingTools = config.tools || []
  const otherTools = existingTools.filter(
    (t) => !(t.type === 'mcp_toolset' && (t as any).mcp_server_name === 'kit')
  )
  return {
    ...config,
    mcp_servers: others,
    tools: otherTools,
  }
}

export interface KitAgentDefinition {
  key: string
  config: AgentConfig
}

interface RegisteredAgent {
  key: string
  agentId: string
  version: string
}

export class AgentRegistry {
  private _client: ReturnType<typeof getManagedAgentsClient> | null = null

  private get client() {
    if (!this._client) {
      this._client = getManagedAgentsClient()
    }
    return this._client
  }

  async register(definition: KitAgentDefinition): Promise<RegisteredAgent> {
    const supabase = createAdminClient()

    const { data: existing } = await supabase
.from('managed_agent_registry')
      .select('external_id')
      .eq('kind', 'agent')
      .eq('key', definition.key)
      .limit(1)
      .maybeSingle()

    const existingAgentId = existing?.external_id as string | undefined

    let agent: AgentResponse
    const enrichedConfig = enrichAgentConfig(definition.config)

    if (existingAgentId) {
      try {
        agent = await this.client.updateAgent(existingAgentId, enrichedConfig)
      } catch {
        agent = await this.client.createAgent(enrichedConfig)
      }
    } else {
      agent = await this.client.createAgent(enrichedConfig)
    }

    const { error: upsertError } = await supabase
.from('managed_agent_registry')
      .upsert({
        kind: 'agent',
        key: definition.key,
        external_id: agent.id,
        version: String(agent.version),
        model: definition.config.model,
        metadata: { registered_at: new Date().toISOString() },
      }, { onConflict: 'kind,key' })

    if (upsertError) {
      throw new Error(`Failed to store agent registration: ${upsertError.message}`)
    }

    return { key: definition.key, agentId: agent.id, version: agent.version }
  }

  async registerAll(definitions: KitAgentDefinition[]): Promise<RegisteredAgent[]> {
    const results: RegisteredAgent[] = []
    for (const def of definitions) {
      try {
        const result = await this.register(def)
        results.push(result)
        console.log(`[Kit] Registered agent: ${def.key} -> ${result.agentId}`)
      } catch (err) {
        console.error(`[Kit] Failed to register agent: ${def.key}`, err)
      }
    }
    return results
  }

  async ensureEnvironment(name: string = 'kit-production'): Promise<string> {
    const supabase = createAdminClient()
    const { data: existing } = await supabase
.from('managed_agent_registry')
      .select('external_id')
      .eq('kind', 'environment')
      .eq('key', name)
      .limit(1)
      .maybeSingle()
    if (existing?.external_id) return existing.external_id as string

    const env = await this.client.createEnvironment({
      name,
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
    })

    const { error: insertError } = await supabase
.from('managed_agent_registry')
      .upsert({
        kind: 'environment',
        key: name,
        external_id: env.id,
        metadata: { registered_at: new Date().toISOString() },
      }, { onConflict: 'kind,key' })

    if (insertError) throw new Error(`Failed to store environment registration: ${insertError.message}`)
    return env.id
  }

  async getAgentId(key: string): Promise<string | null> {
    const supabase = createAdminClient()
    const { data } = await supabase
.from('managed_agent_registry')
      .select('external_id')
      .eq('kind', 'agent')
      .eq('key', key)
      .limit(1)
      .maybeSingle()
    return (data?.external_id as string) || null
  }

  async getEnvironmentId(name: string = 'kit-production'): Promise<string | null> {
    const supabase = createAdminClient()
    const { data } = await supabase
.from('managed_agent_registry')
      .select('external_id')
      .eq('kind', 'environment')
      .eq('key', name)
      .limit(1)
      .maybeSingle()
    return (data?.external_id as string) || null
  }
}

let _registry: AgentRegistry | null = null

export function getAgentRegistry(): AgentRegistry {
  if (!_registry) _registry = new AgentRegistry()
  return _registry
}
