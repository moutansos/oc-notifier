# oc-notifier

A CLI tool that monitors [OpenCode](https://opencode.ai) sessions (and optionally [Claude Code](https://code.claude.com) / [Grok Build](https://grok.com) / [Codex CLI](https://learn.chatgpt.com/codex/cli) / [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview)) and sends push notifications when they become idle. Get notified via Discord, Microsoft Teams, or generic webhooks when your coding sessions are ready for input.

> **Note:** For OpenCode, this tool works best in server/client mode, where multiple clients (TUI or web/desktop) connect to a single OpenCode instance across multiple projects. In this setup, you can step away and receive notifications when any session becomes idle and ready for input.

## Features

- Monitors all projects on an OpenCode server via SSE (Server-Sent Events)
- **Claude Code**, **Grok Build**, **Codex CLI**, and **GitHub Copilot CLI** support via thin plugins/hooks that forward events to an HTTP ingest API
- Detects session status transitions to idle state, questions, and permission prompts
- Sends rich notifications with project name, session title, and desktop link
- Supports multiple notification providers simultaneously
- Auto-reconnects with exponential backoff on connection drops
- Caches session information to reduce API calls

## Requirements

- [Bun](https://bun.sh) runtime

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/oc-notifier.git
cd oc-notifier

# Install dependencies
bun install
```

## Configuration

Create a `config.json` file (see `config.example.json` for reference):

```json
{
  "opencode": {
    "baseUrl": "http://127.0.0.1:4096",
    "desktopBaseUrl": "https://opencode.example.com",
    "username": "opencode",
    "password": "your-password"
  },
  "ingest": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4100,
    "token": "optional-shared-secret"
  },
  "providers": [
    {
      "type": "discord",
      "enabled": true,
      "webhookUrl": "https://discord.com/api/webhooks/..."
    }
  ]
}
```

At least one of `opencode` or `ingest` (with `enabled: true`) is required. You can run OpenCode-only, ingest-only (Claude/Grok/Codex/Copilot plugins), or both.

### General Settings

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `debounceMs` | number | No | Delay before an OpenCode idle notification fires (default: `3000`). Cancelled if the session goes busy again |
| `ignoreDirectories` | string[] | No | Absolute directories to silence. A session is dropped when its project directory is a listed directory or below it |

`ignoreDirectories` applies to every source (OpenCode, Claude Code, Grok, Codex,
Copilot CLI).
It is mainly useful for scratch directories used by headless tooling — for example,
CodexBar's usage probe starts a Claude Code session in `/tmp` about once a
minute, and each one fires a `Stop` hook that would otherwise be reported as an
idle session.

### OpenCode Settings

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `baseUrl` | string | Yes* | OpenCode server API URL |
| `desktopBaseUrl` | string | Yes* | Base URL for OpenCode Desktop links |
| `username` | string | No | HTTP Basic Auth username |
| `password` | string | No | HTTP Basic Auth password |

\*Required when the `opencode` block is present.

### Ingest API (Claude Code / Grok / Codex / Copilot CLI / external clients)

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `enabled` | boolean | Yes | Set `true` to start the HTTP ingest server |
| `host` | string | No | Bind address (default: `127.0.0.1`) |
| `port` | number | No | Listen port (default: `4100`) |
| `token` | string | No | If set, requires `Authorization: Bearer <token>` |

Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/claude-code/hook` | Raw Claude Code hook JSON (used by the plugin) |
| `POST` | `/v1/grok-code/hook` | Raw Grok Build hook JSON (used by the plugin) |
| `POST` | `/v1/codex/hook` | Raw Codex CLI hook JSON (used by the hooks install) |
| `POST` | `/v1/copilot-cli/hook` | Raw Copilot CLI hook JSON (used by the hooks install) |
| `POST` | `/v1/notify` | Normalized notification payload |
| `GET` | `/health` | Liveness check |

### Notification Providers

You can enable multiple providers simultaneously. Each provider has its own configuration.

#### Discord

```json
{
  "type": "discord",
  "enabled": true,
  "webhookUrl": "https://discord.com/api/webhooks/..."
}
```

Sends rich embeds with project info and an action button to open in OpenCode Desktop.

#### Microsoft Teams

```json
{
  "type": "msteams",
  "enabled": true,
  "webhookUrl": "https://outlook.office.com/webhook/..."
}
```

Sends Adaptive Cards with session details.

#### Generic Webhook

```json
{
  "type": "webhook",
  "enabled": true,
  "url": "https://my-server.com/notify",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer secret"
  }
}
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | string | Yes | Webhook endpoint URL |
| `method` | `GET` \| `POST` \| `PUT` | No | HTTP method (default: `POST`) |
| `headers` | object | No | Custom HTTP headers |

Sends a JSON payload:

```json
{
  "event": "session.idle",
  "source": "opencode",
  "session": { "id": "...", "title": "..." },
  "project": { "id": "...", "directory": "..." },
  "desktopUrl": "https://...",
  "hostname": "devbox",
  "timestamp": "2026-02-04T12:00:00Z"
}
```

#### Parent instance (sub-instances)

Forward every notification to another oc-notifier that owns the real Discord /
Teams / webhook configuration. Child instances keep their own OpenCode
`desktopBaseUrl`, project directories, and hostnames in the payload — only
delivery is centralized.

**Parent** (central machine — enable ingest + Discord/Teams/etc.):

```json
{
  "ingest": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 4100,
    "token": "shared-secret"
  },
  "providers": [
    {
      "type": "discord",
      "enabled": true,
      "webhookUrl": "https://discord.com/api/webhooks/..."
    }
  ]
}
```

**Child** (edge machine — no local webhooks):

```json
{
  "opencode": {
    "baseUrl": "http://127.0.0.1:4096",
    "desktopBaseUrl": "https://opencode-on-this-host.example.com"
  },
  "providers": [
    {
      "type": "parent",
      "enabled": true,
      "url": "http://central-notifier.example.com:4100",
      "token": "shared-secret"
    }
  ]
}
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | string | Yes | Parent ingest base URL (e.g. `http://host:4100`) or full `/v1/notify` URL |
| `token` | string | No | Bearer token matching the parent's `ingest.token` (recommended when the parent is not loopback-only) |
| `maxHops` | number | No | Max parent forwards before drop (default: `8`). Guards against accidental cycles |
| `timeoutMs` | number | No | HTTP timeout for the parent notify request in ms (default: `10000`) |

The child POSTs a normalized payload to the parent's `POST /v1/notify`, including
`hostname`, `projectDirectory`, and `desktopUrl` from the origin instance so
Discord/Teams still show the correct machine, path, and OpenCode desktop link.

**Semantics across hops:**

- **Debounce** (`debounceMs`) runs only on the origin OpenCode SSE monitor. Parent
  delivery does not re-debounce forwarded events.
- **`ignoreDirectories`** is applied on every hop against the origin
  `projectDirectory` string. Configure ignores on the child for child-local
  paths (e.g. `/tmp` probes). Configure the same absolute paths on the parent
  only if you intentionally want central filtering by those path strings.
- Set `ingest.token` on any parent whose ingest binds beyond loopback
  (`host: "0.0.0.0"`), and use the same value as the child's `providers[].token`.
  Without a token, a network-reachable parent is an open notification relay.

> Avoid cycles (A → B → A). Nested children are fine as a tree; `maxHops` drops
> runaway chains.

## Claude Code

A bundled plugin under [`claude-code-plugin/`](./claude-code-plugin/) forwards Claude Code hooks to the ingest API. The plugin only relays events; oc-notifier manages providers and formatting.

### Install the plugin

```bash
# Linux/macOS: creates a symlink at ~/.claude/skills/oc-notifier
# Windows: copies the plugin directory (symlinks often need elevation)
# Safe to re-run for upgrades — replaces an existing install
bun run install-claude-plugin
```

Then restart Claude Code or run `/reload-plugins`. Enable ingest on oc-notifier and start it as usual.

### Session-only (no install)

```bash
claude --plugin-dir ./claude-code-plugin
```

See [claude-code-plugin/README.md](./claude-code-plugin/README.md) for `userConfig` (notifier URL / token) and manual test curls.

## Grok Build

A bundled plugin under [`grok-code-plugin/`](./grok-code-plugin/) forwards Grok hooks to the ingest API (same pattern as Claude).

```bash
# Installs to ~/.grok/plugins/oc-notifier (auto-trusted)
bun run install-grok-plugin
```

Restart Grok or run `/plugins reload`. Optional: `OC_NOTIFIER_URL` / `OC_NOTIFIER_TOKEN`.

See [grok-code-plugin/README.md](./grok-code-plugin/README.md).

## Codex CLI

A bundled integration under [`codex-plugin/`](./codex-plugin/) registers Codex
lifecycle hooks that forward **Stop** (idle) and **PermissionRequest** events
to the ingest API.

```bash
# Installs scripts to ~/.codex/hooks/oc-notifier
# Merges Stop + PermissionRequest into ~/.codex/hooks.json
bun run install-codex-plugin
```

Then in Codex run `/hooks` and **trust** the new oc-notifier entries. Optional:
`OC_NOTIFIER_URL` / `OC_NOTIFIER_TOKEN`.

See [codex-plugin/README.md](./codex-plugin/README.md).

## GitHub Copilot CLI

A bundled integration under [`copilot-plugin/`](./copilot-plugin/) registers
Copilot CLI lifecycle hooks that forward **agentStop** (idle) and
**notification** events (`permission_prompt` / `elicitation_dialog`) to the
ingest API.

```bash
# Installs scripts to ~/.copilot/hooks/oc-notifier
# Writes ~/.copilot/hooks/oc-notifier.json
bun run install-copilot-plugin
```

Restart Copilot CLI so hooks reload. Optional: `OC_NOTIFIER_URL` / `OC_NOTIFIER_TOKEN`.

> **Note:** We hook `notification` / `permission_prompt` rather than
> `permissionRequest`. The latter fires *before* auto-allow rules and would
> spam for tools that never show a UI.

See [copilot-plugin/README.md](./copilot-plugin/README.md).

## Usage

### CLI

```bash
# Run with default config (./config.json)
bun run start

# Run with custom config path
bun run src/index.ts --config /path/to/config.json
bun run src/index.ts -c ./my-config.json

# Development mode with auto-reload
bun run dev

# Show help
bun run src/index.ts --help
```

### CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--config <path>` | `-c` | Path to config file (default: `./config.json`) |
| `--install-claude-plugin` | | Install/upgrade Claude Code plugin to `~/.claude/skills/` (symlink on Linux/macOS, copy on Windows; safe to re-run) |
| `--install-grok-plugin` | | Install/upgrade Grok plugin to `~/.grok/plugins/` (symlink on Linux/macOS, copy on Windows; safe to re-run) |
| `--install-codex-plugin` | | Install/upgrade Codex hooks under `~/.codex/hooks/oc-notifier` and merge into `~/.codex/hooks.json` (safe to re-run) |
| `--install-copilot-plugin` | | Install/upgrade Copilot CLI hooks under `~/.copilot/hooks/oc-notifier` and write `oc-notifier.json` (safe to re-run) |
| `--plugin-source <path>` | | Override plugin source directory |
| `--plugin-target <path>` | | Override install target directory |
| `--help` | `-h` | Show help message |

### Docker

```bash
# Build the image
docker build -t oc-notifier .

# Run with config mounted as a volume
docker run -v /path/to/config.json:/config/config.json oc-notifier
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       oc-notifier                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐  │
│  │ SSE Client  │───>│ Event Router │───>│ Notification   │  │
│  │             │    │              │    │ Dispatcher     │  │
│  └─────────────┘    └──────────────┘    └───────┬────────┘  │
│                                                  │          │
│                                         ┌────────▼────────┐ │
│                                         │   Provider      │ │
│                                         │   Registry      │ │
│                                         └────────┬────────┘ │
│                    ┌─────────────────────────────┼─────────┐│
│                    ▼         ▼          ▼        ▼         ││
│              ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   ││
│              │Discord │ │MS Teams│ │Webhook │ │ Parent │   ││
│              └────────┘ └────────┘ └────────┘ └────────┘   ││
└─────────────────────────────────────────────────────────────┘
```

### How It Works

**OpenCode (SSE):**

1. The SSE client connects to OpenCode's `/global/event` endpoint
2. When a `session.status` event with `status.type === "idle"` is received:
   - Checks if this is a transition TO idle (ignores initial idle states)
   - Fetches session info via the `/session/:id` API
   - Dispatches notifications to all enabled providers
3. Question and permission events are forwarded similarly

**Claude Code / Grok / Codex / Copilot CLI (HTTP ingest):**

1. Plugins/hooks capture lifecycle events (`Stop` / `agentStop`, `PermissionRequest`, `Notification`, …)
2. `scripts/forward.sh` POSTs raw hook JSON to `/v1/claude-code/hook`, `/v1/grok-code/hook`,
   `/v1/codex/hook`, or `/v1/copilot-cli/hook`
3. oc-notifier maps the payload to a notification and dispatches to providers

```
┌────────────────┐     ┌─────────────────┐     ┌────────────────┐
│ OpenCode SSE   │────>│                 │     │ Discord /      │
└────────────────┘     │   oc-notifier   │────>│ Teams /        │
┌────────────────┐     │                 │     │ Webhook        │
│ Claude / Grok  │────>│  ingest HTTP    │     └────────────────┘
│ / Codex /      │     └────────▲────────┘
│ Copilot hooks  │              │ parent provider
└────────────────┘     ┌────────┴────────┐
                       │ child instances │
                       └─────────────────┘
```

## License

MIT
