# oc-notifier

A CLI tool that monitors [OpenCode](https://opencode.ai) sessions and sends push notifications when they become idle. Get notified via Discord, Microsoft Teams, or generic webhooks when your coding sessions are ready for input.

> **Note:** This tool works best with OpenCode running in server/client mode, where multiple clients (TUI or web/desktop) connect to a single OpenCode instance across multiple projects. In this setup, you can step away and receive notifications when any session becomes idle and ready for input.

## Features

- Monitors all projects on an OpenCode server via SSE (Server-Sent Events)
- Detects session status transitions to idle state
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
  "providers": [
    {
      "type": "discord",
      "enabled": true,
      "webhookUrl": "https://discord.com/api/webhooks/..."
    }
  ]
}
```

### OpenCode Settings

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `baseUrl` | string | Yes | OpenCode server API URL |
| `desktopBaseUrl` | string | Yes | Base URL for OpenCode Desktop links |
| `username` | string | No | HTTP Basic Auth username |
| `password` | string | No | HTTP Basic Auth password |

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
  "session": { "id": "...", "title": "..." },
  "project": { "id": "...", "directory": "..." },
  "desktopUrl": "https://...",
  "timestamp": "2026-02-04T12:00:00Z"
}
```

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
│                    ▼              ▼              ▼         ││
│              ┌─────────┐   ┌───────────┐   ┌───────────┐   ││
│              │ Discord │   │ MS Teams  │   │  Webhook  │   ││
│              └─────────┘   └───────────┘   └───────────┘   ││
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. The SSE client connects to OpenCode's `/global/event` endpoint
2. When a `session.status` event with `status.type === "idle"` is received:
   - Checks if this is a transition TO idle (ignores initial idle states)
   - Fetches session info via the `/session/:id` API
   - Dispatches notifications to all enabled providers

## License

MIT
