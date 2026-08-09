# AGENTS.md - Coding Agent Guidelines for oc-notifier

This document provides guidelines for AI coding agents working in this repository.

## Project Overview

oc-notifier is a CLI tool that monitors OpenCode sessions via SSE (Server-Sent Events)
and sends push notifications when sessions become idle. Built with Bun and TypeScript.

## Build & Run Commands

```bash
# Install dependencies
bun install

# Run the application
bun run start                              # Uses default ./config.json
bun run src/index.ts --config <path>       # Custom config path
bun run src/index.ts -c ./my-config.json

# Install/upgrade Claude Code plugin (~/.claude/skills/oc-notifier)
# Linux/macOS: symlink  |  Windows: copy  |  safe to re-run
bun run install-claude-plugin

# Install/upgrade Grok plugin (~/.grok/plugins/oc-notifier)
bun run install-grok-plugin

# Install/upgrade Codex hooks (~/.codex/hooks/oc-notifier + hooks.json merge)
bun run install-codex-plugin

# Install/upgrade Copilot CLI hooks (~/.copilot/hooks/oc-notifier + oc-notifier.json)
bun run install-copilot-plugin

# Development mode (auto-reload on changes)
bun run dev

# Type checking
bunx tsc --noEmit

# Direct execution
bun run src/index.ts
```

## Testing

Tests use Bun's built-in test runner and live next to the code they cover
(`src/*.test.ts`):

```bash
# Run all tests
bun test

# Run a single test file
bun test src/opencode-monitor.test.ts

# Run tests matching a pattern
bun test --filter "question"

# Watch mode
bun test --watch
```

## Linting & Formatting

No linting or formatting tools are currently configured. If added, Biome is recommended
for Bun projects.

## Project Structure

```
src/
├── index.ts              # CLI entry point, main() function
├── config.ts             # Configuration loading & validation
├── notifier.ts           # Notification dispatcher
├── sse-client.ts         # SSE connection to OpenCode server
├── opencode-monitor.ts   # OpenCode question/permission handlers → Notification
├── event-dedupe.ts       # One-notification-per-request reservations
├── ingest-server.ts      # HTTP ingest API for Claude / Grok / Codex / Copilot / external clients
├── claude-code.ts        # Map Claude Code hook payloads → Notification
├── grok-code.ts          # Map Grok hook payloads → Notification
├── codex.ts              # Map Codex CLI hook payloads → Notification
├── copilot-cli.ts        # Map Copilot CLI hook payloads → Notification
├── install-plugin.ts         # Shared symlink/copy install helper
├── install-claude-plugin.ts  # --install-claude-plugin
├── install-grok-plugin.ts    # --install-grok-plugin
├── install-codex-plugin.ts   # --install-codex-plugin
├── install-copilot-plugin.ts # --install-copilot-plugin
└── providers/
    ├── index.ts          # Provider factory/registry
    ├── types.ts          # Provider interfaces & types
    ├── discord.ts        # Discord webhook provider
    ├── msteams.ts        # Microsoft Teams provider
    ├── webhook.ts        # Generic webhook provider
    └── parent.ts         # Forward to parent oc-notifier (sub-instances)

claude-code-plugin/       # Claude Code plugin (hooks only; oc-notifier owns delivery)
├── .claude-plugin/plugin.json
├── hooks/hooks.json
└── scripts/forward.sh

grok-code-plugin/         # Grok Build plugin (hooks only)
├── plugin.json
├── hooks/hooks.json
└── scripts/forward.sh

codex-plugin/             # Codex CLI hooks (Stop + PermissionRequest)
├── .codex-plugin/plugin.json
├── hooks/hooks.json
└── scripts/forward.sh

copilot-plugin/           # Copilot CLI hooks (agentStop + notification)
├── hooks/hooks.json
└── scripts/forward.sh
```

## TypeScript Configuration

Key settings from `tsconfig.json`:
- **Target**: ESNext (runs on Bun, no transpilation)
- **Strict mode**: Enabled
- **noUncheckedIndexedAccess**: true - array/object indexing returns `T | undefined`
- **verbatimModuleSyntax**: true - use `import type` for type-only imports
- **allowImportingTsExtensions**: true - use `.ts` extensions in imports

## Code Style Guidelines

### Naming Conventions
- **Files**: kebab-case (`sse-client.ts`, `config.ts`)
- **Classes/Interfaces/Types**: PascalCase (`SSEClient`, `NotificationProvider`)
- **Functions/Variables/Properties**: camelCase (`loadConfig`, `webhookUrl`)
- **No SCREAMING_SNAKE_CASE** for constants (use camelCase)

### Imports
Always use `.ts` extensions and `import type` for type-only imports:

```typescript
import { parseArgs } from "util";           // External imports first
import { loadConfig } from "./config.ts";   // Local imports with .ts extension

import type { ProviderConfig } from "../config.ts";  // Type-only imports
```

### Classes
Use `readonly` for immutable properties, `private` keyword (not underscore prefix):

```typescript
export class DiscordProvider implements NotificationProvider {
  readonly type = "discord";
  readonly enabled: boolean;
  private readonly webhookUrl: string;

  constructor(config: DiscordProviderConfig) {
    this.enabled = config.enabled;
    this.webhookUrl = config.webhookUrl;
  }
}
```

### Error Handling
- Throw `Error` with descriptive messages for validation failures
- Use try/catch for async operations
- Use `Promise.allSettled()` for parallel operations that shouldn't fail together

```typescript
// Validation errors
if (typeof obj.baseUrl !== "string" || !obj.baseUrl) {
  throw new Error("opencode.baseUrl is required and must be a string");
}

// HTTP errors
if (!response.ok) {
  const text = await response.text();
  throw new Error(`Discord webhook failed: ${response.status} ${text}`);
}
```

### Async Patterns
- Use async/await throughout (no raw Promises or callbacks)
- Use native `fetch()` API (Bun built-in)

### Documentation
Use JSDoc-style comments at top of files: `/** SSE Client for OpenCode server */`

### Console Output
- Use `console.log()` for informational, `console.error()` for errors
- Include context: `console.log(\`Session ${sessionID} transitioned to idle\`)`

## Adding a New Provider

1. Create a new file in `src/providers/` (e.g., `slack.ts`)
2. Implement the `NotificationProvider` interface from `./types.ts`
3. Add config type to `src/config.ts` and update `ProviderConfig` union
4. Add validation function in `src/config.ts`
5. Register in `src/providers/index.ts`

## Parent / sub-instances

A child oc-notifier can use provider type `parent` to POST normalized
notifications to another instance's `POST /v1/notify`. Always preserve
`hostname`, `projectDirectory`, and `desktopUrl` from the origin — do not
rewrite them to the parent's values.

## Bun-Specific APIs

This project uses Bun-specific APIs:
- `Bun.file()` for file operations
- `Bun.argv` for CLI arguments
- Native fetch (Bun built-in)
