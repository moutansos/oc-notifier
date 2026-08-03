# oc-notifier Claude Code plugin

Thin Claude Code plugin that forwards idle, permission, and question events to
[oc-notifier](https://code.msyke.dev/mSyke/oc-notifier). **oc-notifier owns
notification routing** (Discord, Microsoft Teams, generic webhooks); this plugin
only relays Claude Code hook payloads.

## How it works

```
Claude Code hooks  →  forward.sh  →  oc-notifier HTTP ingest  →  providers
  Notification           POST /v1/claude-code/hook
  PermissionRequest
```

Hooked events:

| Claude Code event | Matcher / tools | oc-notifier type |
|-------------------|-----------------|------------------|
| `Notification` | `idle_prompt`, `agent_completed` | `idle` |
| `Notification` | `permission_prompt`, `agent_needs_input` | `permission` |
| `Notification` | `elicitation_dialog` | `question` |
| `PermissionRequest` | all tools (incl. `AskUserQuestion`) | `permission` / `question` |
| `Stop` | (always) | `idle` |

**Permissions:** Claude fires a dedicated **`PermissionRequest`** hook when a tool needs
approval, plus `Notification` / `permission_prompt` for the desktop-style alert. Both are
forwarded as `permission` (`AskUserQuestion` → `question`).

Subagent events (`agent_id` present) are ignored by oc-notifier.

## Prerequisites

1. [oc-notifier](../README.md) running with ingest enabled
2. `curl` available on your `PATH`
3. Claude Code with plugin support

## Enable ingest on oc-notifier

Add to your `config.json`:

```json
{
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

`opencode` can be omitted if you only use Claude Code.

## Install the plugin

### Recommended: oc-notifier CLI

From the oc-notifier repo:

```bash
# Linux/macOS → symlink  |  Windows → copy
# Installs to ~/.claude/skills/oc-notifier
# Safe to re-run for upgrades — replaces an existing install
bun run install-claude-plugin

# Optional overrides
bun run src/index.ts --install-claude-plugin \
  --plugin-source ./claude-code-plugin \
  --plugin-target ~/.claude/skills/oc-notifier
```

Then restart Claude Code (or run `/reload-plugins`).

### Session-only (no install)

```bash
claude --plugin-dir /path/to/oc-notifier/claude-code-plugin
```

### Manual skills-directory install

```bash
# Linux/macOS
ln -s /path/to/oc-notifier/claude-code-plugin ~/.claude/skills/oc-notifier

# Windows (PowerShell) — copy instead of symlink
Copy-Item -Recurse .\claude-code-plugin $env:USERPROFILE\.claude\skills\oc-notifier
```

When enabling, Claude Code prompts for:

| Option | Description | Default |
|--------|-------------|---------|
| **oc-notifier URL** | Base URL of the ingest API | `http://127.0.0.1:4100` |
| **Auth token** | Optional bearer token matching `ingest.token` | _(empty)_ |

## Verify

1. Start oc-notifier with ingest enabled
2. In Claude Code, run `/hooks` and confirm `Notification` / `PermissionRequest` hooks from this plugin
3. Let Claude finish a turn or request a permission — you should see an ingest log line and a provider notification

## Manual test

```bash
# Idle-style notification
echo '{
  "session_id": "test-session",
  "cwd": "/tmp/demo",
  "hook_event_name": "Notification",
  "message": "Claude is waiting for your input",
  "notification_type": "idle_prompt"
}' | curl -sS -X POST http://127.0.0.1:4100/v1/claude-code/hook \
  -H 'Content-Type: application/json' \
  -d @-

# Permission prompt
echo '{
  "session_id": "test-session",
  "cwd": "/tmp/demo",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/build", "description": "clean build" }
}' | curl -sS -X POST http://127.0.0.1:4100/v1/claude-code/hook \
  -H 'Content-Type: application/json' \
  -d @-
```
