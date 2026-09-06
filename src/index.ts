/**
 * oc-notifier - CLI entry point
 *
 * Connects to OpenCode v1 and/or OpenCode 2 SSE streams and/or listens for
 * HTTP ingest events (Claude Code / Grok / Codex / Copilot CLI hooks) and
 * sends push notifications when sessions become idle, when a question is
 * asked, or when a permission request is pending.
 */

import { parseArgs } from "util";
import { loadConfig, type OpenCodeConfig } from "./config.ts";
import { SSEClient } from "./sse-client.ts";
import { SSEClientV2 } from "./sse-client-v2.ts";
import { createProviders, type Notification } from "./providers/index.ts";
import { Notifier } from "./notifier.ts";
import { IngestServer } from "./ingest-server.ts";
import { installClaudePlugin } from "./install-claude-plugin.ts";
import { installGrokPlugin } from "./install-grok-plugin.ts";
import { installCodexPlugin } from "./install-codex-plugin.ts";
import { installCopilotPlugin } from "./install-copilot-plugin.ts";
import { EventDeduper } from "./event-dedupe.ts";
import {
  buildDesktopUrl,
  createPermissionHandler,
  createQuestionHandler,
  type MonitorDeps,
} from "./opencode-monitor.ts";

import type { PermissionEvent, QuestionEvent, SessionInfo, SessionStatusEvent } from "./sse-client.ts";
import type { NotificationSource } from "./providers/types.ts";

/** Shared surface of the v1 and v2 SSE clients used by the monitor setup */
interface SessionMonitor {
  onSessionStatus(handler: (event: SessionStatusEvent, directory: string) => void): void;
  onQuestion(handler: (question: QuestionEvent, directory: string) => void): void;
  onPermission(handler: (permission: PermissionEvent, directory: string) => void): void;
  fetchSessionInfo(sessionId: string, directory: string): Promise<SessionInfo | null>;
  confirmIdle?(sessionID: string): Promise<boolean>;
  start(): Promise<void>;
  stop(): void;
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: {
      type: "string",
      short: "c",
      default: "./config.json",
    },
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
    "install-claude-plugin": {
      type: "boolean",
      default: false,
    },
    "install-grok-plugin": {
      type: "boolean",
      default: false,
    },
    "install-codex-plugin": {
      type: "boolean",
      default: false,
    },
    "install-copilot-plugin": {
      type: "boolean",
      default: false,
    },
    "plugin-source": {
      type: "string",
    },
    "plugin-target": {
      type: "string",
    },
  },
});

if (values.help) {
  console.log(`
oc-notifier - OpenCode / Claude Code / Grok / Codex / Copilot CLI session idle notifier

Usage:
  bun run src/index.ts [options]

Options:
  -c, --config <path>           Path to config file (default: ./config.json)
  --install-claude-plugin       Install/upgrade the Claude Code plugin into ~/.claude/skills/
                                Linux/macOS: symlink  |  Windows: copy
  --install-grok-plugin         Install/upgrade the Grok plugin into ~/.grok/plugins/
                                Linux/macOS: symlink  |  Windows: copy
  --install-codex-plugin        Install/upgrade Codex hooks into ~/.codex/hooks/
                                (also merges Stop + PermissionRequest into hooks.json)
  --install-copilot-plugin      Install/upgrade Copilot CLI hooks into ~/.copilot/hooks/
                                (writes oc-notifier.json + scripts)
  --plugin-source <path>        Override plugin source directory
  --plugin-target <path>        Override install target directory
  -h, --help                    Show this help message

Examples:
  bun run src/index.ts --config /path/to/config.json
  bun run src/index.ts --install-claude-plugin
  bun run src/index.ts --install-grok-plugin
  bun run src/index.ts --install-codex-plugin
  bun run src/index.ts --install-copilot-plugin
`);
  process.exit(0);
}

async function main() {
  if (values["install-claude-plugin"]) {
    const summary = await installClaudePlugin({
      sourceDir: values["plugin-source"],
      targetDir: values["plugin-target"],
    });
    console.log(summary);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Ensure oc-notifier is running with ingest.enabled: true");
    console.log("  2. Restart Claude Code or run /reload-plugins");
    console.log("  3. Configure notifier URL / token if prompted (plugin userConfig)");
    process.exit(0);
  }

  if (values["install-grok-plugin"]) {
    const summary = await installGrokPlugin({
      sourceDir: values["plugin-source"],
      targetDir: values["plugin-target"],
    });
    console.log(summary);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Ensure oc-notifier is running with ingest.enabled: true (port 4100)");
    console.log("  2. Restart Grok or run /plugins reload");
    console.log("  3. Optional: export OC_NOTIFIER_URL / OC_NOTIFIER_TOKEN");
    process.exit(0);
  }

  if (values["install-codex-plugin"]) {
    const summary = await installCodexPlugin({
      sourceDir: values["plugin-source"],
      targetDir: values["plugin-target"],
    });
    console.log(summary);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Ensure oc-notifier is running with ingest.enabled: true (port 4100)");
    console.log("  2. In Codex, run /hooks and trust the oc-notifier Stop + PermissionRequest hooks");
    console.log("     (re-install may require re-trusting hooks; definition hashes can change)");
    console.log("  3. Requires bash + curl on PATH; optional: OC_NOTIFIER_URL / OC_NOTIFIER_TOKEN");
    process.exit(0);
  }

  if (values["install-copilot-plugin"]) {
    const summary = await installCopilotPlugin({
      sourceDir: values["plugin-source"],
      targetDir: values["plugin-target"],
    });
    console.log(summary);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Ensure oc-notifier is running with ingest.enabled: true (port 4100)");
    console.log("  2. Restart Copilot CLI so hooks reload");
    console.log("  3. Optional: export OC_NOTIFIER_URL / OC_NOTIFIER_TOKEN");
    process.exit(0);
  }

  const configPath = values.config!;

  console.log(`Loading config from ${configPath}...`);
  const config = await loadConfig(configPath);

  // Create providers
  const providers = createProviders(config.providers);
  const notifier = new Notifier(providers, config.ignoreDirectories);

  // Start HTTP ingest server (Claude Code plugin and other clients)
  let ingestServer: IngestServer | null = null;
  if (config.ingest?.enabled) {
    ingestServer = new IngestServer(config.ingest, notifier);
    ingestServer.start();
  }

  // OpenCode SSE monitoring (v1 and/or v2; optional when only ingest is used)
  const monitors: SessionMonitor[] = [];
  if (config.opencode) {
    monitors.push(setupOpenCodeMonitoring(
      new SSEClient(config.opencode),
      config.opencode,
      config.debounceMs,
      notifier,
      "opencode",
    ));
  } else {
    console.log("OpenCode SSE monitoring disabled (no opencode config)");
  }

  if (config.opencode2) {
    monitors.push(setupOpenCodeMonitoring(
      new SSEClientV2(config.opencode2),
      config.opencode2,
      config.debounceMs,
      notifier,
      "opencode2",
    ));
  } else {
    console.log("OpenCode 2 SSE monitoring disabled (no opencode2 config)");
  }

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    for (const monitor of monitors) {
      monitor.stop();
    }
    ingestServer?.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Starting oc-notifier...");

  if (monitors.length > 0) {
    await Promise.all(monitors.map((monitor) => monitor.start()));
  } else {
    // Keep process alive for ingest-only mode
    console.log("Running in ingest-only mode (waiting for HTTP events)...");
    await new Promise(() => {});
  }
}

function setupOpenCodeMonitoring(
  sseClient: SessionMonitor,
  opencodeConfig: OpenCodeConfig,
  debounceMs: number,
  notifier: Notifier,
  source: NotificationSource,
): SessionMonitor {
  // Track previous session status to detect transitions TO idle
  // Map of sessionID -> { status, lastSeen }
  const sessionState = new Map<string, { status: string; lastSeen: number }>();

  // Track pending notification timers for debouncing
  const pendingNotifications = new Map<string, Timer>();

  // Track known subagent sessions to avoid re-fetching
  const knownSubagents = new Set<string>();

  // Cleanup old sessions periodically (every 5 minutes, remove entries older than 1 hour)
  const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionID, state] of sessionState) {
      if (now - state.lastSeen > SESSION_TTL_MS) {
        sessionState.delete(sessionID);
        knownSubagents.delete(sessionID);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} stale session(s) from tracking`);
    }
  }, CLEANUP_INTERVAL_MS);

  console.log(`Debounce delay: ${debounceMs}ms (${source})`);

  // Handle session status events
  sseClient.onSessionStatus(async (event, directory) => {
    const { sessionID, status } = event.properties;
    const prevState = sessionState.get(sessionID);
    const prevStatus = prevState?.status;
    const currentStatus = status.type;
    const now = Date.now();

    console.log(`[DEBUG] Session ${sessionID} event: ${prevStatus ?? "(new)"} -> ${currentStatus} (project: ${directory}, timestamp: ${now})`);

    // Update tracked status with timestamp
    sessionState.set(sessionID, { status: currentStatus, lastSeen: now });

    // Skip known subagent sessions early
    if (knownSubagents.has(sessionID)) {
      return;
    }

    // If session goes busy/retry, cancel any pending notification
    if (currentStatus !== "idle") {
      const pendingTimer = pendingNotifications.get(sessionID);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingNotifications.delete(sessionID);
        console.log(`Session ${sessionID} went ${currentStatus}, cancelled pending notification`);
      } else {
        console.log(`Session ${sessionID} status: ${currentStatus} (project: ${directory})`);
      }
      return;
    }

    // Only notify when transitioning TO idle (not on initial idle)
    if (currentStatus === "idle" && prevStatus && prevStatus !== "idle") {
      // Check if there's already a pending notification (shouldn't happen, but be safe)
      if (pendingNotifications.has(sessionID)) {
        return;
      }

      console.log(`Session ${sessionID} went idle, scheduling notification in ${debounceMs}ms...`);

      // Schedule the notification after debounce delay
      const timer = setTimeout(async () => {
        pendingNotifications.delete(sessionID);

        // Double-check the session is still idle
        const currentState = sessionState.get(sessionID);
        if (currentState?.status !== "idle") {
          console.log(`Session ${sessionID} no longer idle, skipping notification`);
          return;
        }

        // Fetch session info to check if it's a subagent
        const sessionInfo = await sseClient.fetchSessionInfo(sessionID, directory);

        // Skip subagent sessions (those with a parent session)
        if (sessionInfo?.parentSessionID) {
          console.log(`Session ${sessionID} is a subagent (parent: ${sessionInfo.parentSessionID}), skipping notification`);
          knownSubagents.add(sessionID);
          return;
        }

        if (sseClient.confirmIdle) {
          const stillIdle = await sseClient.confirmIdle(sessionID);
          if (!stillIdle) {
            console.log(`Session ${sessionID} still active on server, skipping notification`);
            sessionState.set(sessionID, { status: "busy", lastSeen: Date.now() });
            return;
          }
        }

        const projectDirectory = directory || sessionInfo?.directory || "";
        console.log(`Session ${sessionID} still idle, sending notification (project: ${projectDirectory})`);
        console.log(`[DEBUG] sessionInfo: ${JSON.stringify(sessionInfo)}`);

        const notification: Notification = {
          type: "idle",
          source,
          sessionId: sessionID,
          sessionTitle: sessionInfo?.title || sessionID,
          projectId: sessionInfo?.projectID || "",
          projectDirectory,
          desktopUrl: buildDesktopUrl(opencodeConfig.desktopBaseUrl, projectDirectory, sessionID),
          timestamp: new Date(),
        };

        console.log(`[DEBUG] Sending notification: ${JSON.stringify(notification)}`);
        await notifier.send(notification);
      }, debounceMs);

      pendingNotifications.set(sessionID, timer);
    }
  });

  // One ask reaches us as both question.asked and the question tool part, so a
  // reservation covers the request id and the tool call id.
  const requestTtlMs = 30 * 60 * 1000; // 30 minutes
  const monitorDeps: MonitorDeps = {
    questions: new EventDeduper(requestTtlMs),
    permissions: new EventDeduper(requestTtlMs),
    knownSubagents,
    fetchSessionInfo: (sessionID, directory) =>
      sseClient.fetchSessionInfo(sessionID, directory),
    send: (notification) => notifier.send(notification),
    desktopBaseUrl: opencodeConfig.desktopBaseUrl,
    source,
  };

  setInterval(() => {
    monitorDeps.questions.prune();
    monitorDeps.permissions.prune();
  }, CLEANUP_INTERVAL_MS);

  sseClient.onQuestion(createQuestionHandler(monitorDeps));
  sseClient.onPermission(createPermissionHandler(monitorDeps));

  return sseClient;
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
