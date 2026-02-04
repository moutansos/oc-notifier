# 001: oc-notifier

A CLI tool that connects to an OpenCode server's SSE stream, monitors session status changes, and sends push notifications when sessions transition to `idle` state.

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
│                    ┌─────────────────────────────┼─────────┤│
│                    ▼              ▼              ▼         ││
│              ┌─────────┐   ┌───────────┐   ┌───────────┐   ││
│              │ Discord │   │  Webhook  │   │  (future) │   ││
│              │ Webhook │   │  Generic  │   │  Slack..  │   ││
│              └─────────┘   └───────────┘   └───────────┘   ││
└─────────────────────────────────────────────────────────────┘
```

## Technology

**TypeScript with Bun** because:
- The OpenCode SDK is already TypeScript - full type safety for events
- Bun has excellent SSE/streaming support
- Fast startup, good for CLI tools
- Easy Docker containerization

## Configuration File (`config.json`)

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
    },
    {
      "type": "webhook",
      "enabled": true,
      "url": "https://my-server.com/notify",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer secret"
      }
    }
  ]
}
```

Note: `username` and `password` are optional. If provided, they are used for HTTP Basic Auth when connecting to the OpenCode server.

## Provider Interface

```typescript
interface NotificationProvider {
  type: string;
  enabled: boolean;
  send(notification: Notification): Promise<void>;
}

interface Notification {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  desktopUrl: string;
  timestamp: Date;
}
```

## File Structure

```
oc-notifier/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── config.ts             # Config loading/validation
│   ├── sse-client.ts         # SSE connection to OpenCode
│   ├── notifier.ts           # Dispatches to providers
│   └── providers/
│       ├── index.ts          # Provider registry
│       ├── types.ts          # Provider interface
│       ├── discord.ts        # Discord webhook
│       └── webhook.ts        # Generic webhook
├── config.json               # User config (gitignored)
├── config.example.json       # Example config (committed)
├── package.json
├── tsconfig.json
├── Dockerfile
└── .gitignore
```

## Notification Message Format

### Discord (rich embed)

```
Session Idle

Session: "Fix authentication bug"
Status: Ready for input

[Open in OpenCode Desktop]
```

### Generic Webhook (JSON body)

```json
{
  "event": "session.idle",
  "session": {
    "id": "ses_3d8a9b1c3ffe1KQkcnleyAzVMC",
    "title": "Fix authentication bug"
  },
  "project": {
    "id": "L2hvbWUvYmVuL3NvdXJjZS9yZXBvcy9oYXJtb25leQ"
  },
  "desktopUrl": "https://opencode.example.com/L2hvbWUv.../session/ses_3d8a9b1c...",
  "timestamp": "2026-02-04T12:00:00Z"
}
```

## CLI Usage

```bash
# Run with default config path (./config.json)
bun run src/index.ts

# Run with custom config
bun run src/index.ts --config /path/to/config.json

# Future: as installed binary
oc-notifier --config ~/.config/oc-notifier/config.json
```

## OpenCode SSE Events

The tool connects to the OpenCode `/event` SSE endpoint and listens for `session.status` events:

```typescript
type EventSessionStatus = {
  type: "session.status"
  properties: {
    sessionID: string
    status: SessionStatus
  }
}

type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
```

The tool triggers notifications when `status.type` changes to `"idle"`.

## Implementation Steps

1. **Project Setup**
   - Initialize bun project
   - Set up TypeScript config
   - Create `.gitignore` with `config.json`
   - Create `config.example.json`

2. **Config Module**
   - Load and validate JSON config
   - Type-safe config schema
   - Support optional username/password for Basic Auth

3. **SSE Client**
   - Connect to OpenCode `/event` endpoint
   - Support HTTP Basic Auth if configured
   - Parse SSE events
   - Filter for `session.status` where status changes to `idle`
   - Auto-reconnect with exponential backoff on connection drop

4. **Session Info Fetching**
   - When a session goes idle, fetch `/session/:id` to get session title
   - Cache session info to reduce API calls for repeated events

5. **Provider System**
   - Provider interface/abstract class
   - Provider registry
   - Discord webhook provider
   - Generic webhook provider

6. **Notifier/Dispatcher**
   - Iterate enabled providers
   - Send notification to each
   - Handle failures gracefully (log, don't crash)

7. **Docker Support**
   - Dockerfile for containerization
   - Mount config as volume

## Future Providers

- Slack
- Email (SMTP)
- Native OS notifications
- Google Cloud Messaging (GCM) / Firebase Cloud Messaging (FCM)
- Pushover
- ntfy.sh
- Telegram

## Design Decisions

1. **Session title retrieval**: When a `session.status` event indicates idle, fetch `/session/:id` to get the session title for richer notifications.

2. **Reconnection handling**: Auto-reconnect with exponential backoff when the SSE connection drops. Initial delay of 1 second, doubling up to a max of 30 seconds.

3. **Authentication**: Support optional `username` and `password` in config for HTTP Basic Auth to the OpenCode server.

4. **Rate limiting**: Not implemented initially. Notify immediately for each idle event.

5. **Filtering**: Not implemented initially. All sessions trigger notifications.
