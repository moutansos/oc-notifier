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

# Development mode (auto-reload on changes)
bun run dev

# Type checking
bunx tsc --noEmit

# Direct execution
bun run src/index.ts
```

## Testing

No test framework is currently configured. If tests are added, use Bun's built-in test runner:

```bash
# Run all tests
bun test

# Run a single test file
bun test src/providers/discord.test.ts

# Run tests matching a pattern
bun test --filter "discord"

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
└── providers/
    ├── index.ts          # Provider factory/registry
    ├── types.ts          # Provider interfaces & types
    ├── discord.ts        # Discord webhook provider
    ├── msteams.ts        # Microsoft Teams provider
    └── webhook.ts        # Generic webhook provider
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

## Bun-Specific APIs

This project uses Bun-specific APIs:
- `Bun.file()` for file operations
- `Bun.argv` for CLI arguments
- Native fetch (Bun built-in)
