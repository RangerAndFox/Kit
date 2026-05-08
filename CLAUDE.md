# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This repo contains **two deployable apps that share a code library**:

- **Next.js app** (root) — admin UI, Supabase auth, MCP server at `/api/mcp`, Inngest functions at `/api/inngest`. Deployed serverless.
- **Bolt app** (`bolt/`) — persistent Slack Socket Mode bot. Deployed to Railway from `bolt/Dockerfile`, which copies *both* `bolt/src/` and `src/lib/` into the image so Bolt can import the shared agent code via `../../../src/lib/...` paths.

A change in `src/lib/` affects both apps. A change in `src/app/` only affects Next.js. A change in `bolt/src/` only affects the Slack bot.

## Common Commands

**Root (Next.js):**
```bash
npm run dev          # next dev on port 3001
npm run build        # next build
npm run lint         # eslint
```

**Bolt (Slack):**
```bash
cd bolt
npm run dev          # tsx watch src/app.ts
npm run start        # tsx src/app.ts
npm run test         # vitest run
npm run test:watch   # vitest
npx vitest run test/orchestrator.test.ts   # single test file
```

There is no root-level test script — tests live only in `bolt/test/`.

## Architecture

### Two parallel "agent" concepts — don't confuse them

1. **Service-domain agents** in `src/lib/inngest/agents/` (`harvest`, `dropbox`, `frameio`, `slack`). Each owns one external API. Registered in `src/lib/inngest/agents/registry.ts`. Dispatched via `dispatch()` from that registry. These are what the Slack bot's specialists call.

2. **Managed Kit agents** in `agents/` at the repo root (`production-monitor`, `sow-generator`, `script-writer`, etc.). Registered with Anthropic's Managed Agents API via `src/lib/managed-agents/`. Different runtime entirely.

When the user says "agent," ask which kind. The Frame.io migration touched #1.

### Provisioning flow (Inngest)

Trigger: an MCP tool call or Slack command sends `kit/project.provision` via `inngest.send()`. The orchestrator (`src/lib/inngest/orchestrator.ts`) runs in phases:

1. Post status message to Slack
2. **Parallel**: Harvest, Dropbox, Frame.io agents (each as `step.run`, 2 retries)
3. **Sequential**: Slack agent (needs URLs from phase 2)
4. Stitch all returned URLs into the Supabase project record
5. Update the Slack status message

Agents return `AgentResult` (`{ success, url?, id?, error?, ... }`) — they **never throw**, they catch and return `{ success: false, error }`. The orchestrator is service-agnostic; it just collects results.

There is also a legacy `src/lib/provisioner/` (Canva, OneDrive, Clockify, Figma, etc.) that has not yet been migrated to the Inngest pattern. Per `docs/agent-architecture.md`, this is Phase 2 work. New service integrations should go in `src/lib/inngest/agents/`.

### Slack bot loop (Bolt)

`bolt/src/app.ts` boots Bolt in Socket Mode and registers the Assistant + message/command/interaction handlers. Inbound user messages flow into `bolt/src/llm/orchestrator.ts`:

1. Orchestrator (Claude Sonnet) decides which specialist to invoke via `tool_use`
2. Each specialist (`bolt/src/llm/specialist.ts`) is a domain-specific Claude run with a single agent's system prompt + tools (capability list from `agents/registry.ts`)
3. Specialist picks one action, calls `dispatch(agentId, action, payload)` (gated by `enforceAccess()`), composes a structured summary
4. Orchestrator may chain up to `MAX_TURNS = 6` specialist calls before replying

System prompts live in `bolt/src/llm/prompts/`. Conversation memory is per-`(team, channel, user)` in `bolt/src/llm/memory.ts`.

### Access control

`src/lib/inngest/access-control.ts` enforces three tiers (`admin` / `producer` / `artist`) at two levels: the gateway blocks whole agent actions, and individual agents filter sensitive fields from results. Tier is resolved from `team_members.role` + `project_access.can_see_financials`. Always pass a `UserContext` through to `dispatch()`.

### MCP server

`src/lib/mcp/server.ts` implements MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`) directly over HTTP — no SDK transport — because the route is stateless serverless. Tools are registered as a flat array; each tool defines a Zod input schema. The route is `src/app/api/mcp/route.ts` (and a per-key variant at `[key]/route.ts`).

### Supabase

Migrations in `supabase/migrations/` are numbered (`001_…` through `010_…`+). Three client factories in `src/lib/supabase/`: `client.ts` (browser), `server.ts` (RSC/server actions), `admin.ts` (service-role, server-only). The proxy at `src/proxy.ts` is Next.js middleware that refreshes auth cookies via `@supabase/ssr`.

## Conventions

- **`// @ts-nocheck` at the top of shared library files** is widespread (~49 files in `src/lib/`). The convention is to skip strict typing in service-integration code that mostly shapes external API responses; types are enforced at the boundaries (`AgentDefinition`, `AgentResult`, MCP tool schemas, Zod). Don't reflexively add types to existing `// @ts-nocheck` files.
- **Path alias `@/*` → `src/*`** (root tsconfig). Bolt's vitest config aliases `@` to `../src` so the same import paths work in tests.
- **Frame.io v4 auth** uses Adobe IMS refresh-token flow (`src/lib/frameio/auth.ts`) — env vars are `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET`, `ADOBE_REFRESH_TOKEN`, `FRAMEIO_ACCOUNT_ID`, `FRAMEIO_WORKSPACE_ID`. Note: `src/lib/mcp/provisioners.ts` still has a v2-era duplicate `provisionFrameIo` and has not been migrated.
- **`new_project_service_module_code/`** is legacy reference (a prior Teams-bot version of the provisioner). Don't import from it; use it only as a reference.
- Slack bot must stay online 24/7. `railway.toml` sets `sleepApplication = false` and the Bolt app binds a dummy HTTP port to satisfy Railway's lifecycle.
