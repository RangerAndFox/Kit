import type { App, SlackCommandMiddlewareArgs } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'

export type CommandInvocation = Pick<SlackCommandMiddlewareArgs, 'command' | 'ack' | 'respond'> & { client: WebClient }
type Handler = (context: CommandInvocation) => Promise<void>
const handlers = new WeakMap<App, Map<string, Handler>>()

/** One implementation for slash commands and confirmed natural requests. */
export function registerKitCommand(app: App, name: string, handler: Handler): void {
  let registry = handlers.get(app)
  if (!registry) handlers.set(app, registry = new Map())
  registry.set(name, handler)
  app.command(name, handler)
}

export async function dispatchKitCommand(app: App, name: '/kit' | '/storyboard', context: CommandInvocation): Promise<void> {
  const handler = handlers.get(app)?.get(name)
  if (!handler) throw new Error('Command handler is not registered')
  await handler(context)
}
