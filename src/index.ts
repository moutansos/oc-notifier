/**
 * oc-notifier - CLI entry point
 *
 * Connects to an OpenCode server's SSE stream and sends push notifications
 * when sessions transition to idle state or when the question tool is invoked.
 */

import { parseArgs } from "util";
import { loadConfig } from "./config.ts";
import { SSEClient } from "./sse-client.ts";
import { createProviders, type Notification } from "./providers/index.ts";
import { Notifier } from "./notifier.ts";

import type { ToolState } from "./sse-client.ts";

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
  },
});

if (values.help) {
  console.log(`
oc-notifier - OpenCode session idle notifier

Usage:
  bun run src/index.ts [options]

Options:
  -c, --config <path>  Path to config file (default: ./config.json)
  -h, --help           Show this help message

Example:
  bun run src/index.ts --config /path/to/config.json
`);
  process.exit(0);
}

async function main() {
  const configPath = values.config!;

  console.log(`Loading config from ${configPath}...`);
  const config = await loadConfig(configPath);

  // Create providers
  const providers = createProviders(config.providers);
  const notifier = new Notifier(providers);

  // Create SSE client
  const sseClient = new SSEClient(config.opencode);

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

  console.log(`Debounce delay: ${config.debounceMs}ms`);

  // Handle session status events (from all projects via /global/event)
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

      console.log(`Session ${sessionID} went idle, scheduling notification in ${config.debounceMs}ms...`);

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

        console.log(`Session ${sessionID} still idle, sending notification (project: ${directory})`);
        console.log(`[DEBUG] sessionInfo: ${JSON.stringify(sessionInfo)}`);

        const notification: Notification = {
          type: "idle",
          sessionId: sessionID,
          sessionTitle: sessionInfo?.title || sessionID,
          projectId: sessionInfo?.projectID || "",
          projectDirectory: directory,
          desktopUrl: buildDesktopUrl(config.opencode.desktopBaseUrl, sessionInfo?.projectID || "", sessionID),
          timestamp: new Date(),
        };

        console.log(`[DEBUG] Sending notification: ${JSON.stringify(notification)}`);
        await notifier.send(notification);
      }, config.debounceMs);

      pendingNotifications.set(sessionID, timer);
    }
  });

  // Track question tool calls to avoid duplicate notifications
  // Map of "sessionID:callID" -> timestamp when we notified
  const notifiedQuestions = new Map<string, number>();

  // Clean up old question tracking entries periodically
  const QUESTION_TTL_MS = 30 * 60 * 1000; // 30 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of notifiedQuestions) {
      if (now - timestamp > QUESTION_TTL_MS) {
        notifiedQuestions.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Handle question tool events
  sseClient.onQuestionTool(async (sessionID: string, toolState: ToolState, directory: string) => {
    // Only notify when the question tool is in "running" state (waiting for user input)
    if (toolState.status !== "running") {
      return;
    }

    // Skip known subagent sessions
    if (knownSubagents.has(sessionID)) {
      return;
    }

    // Extract question text from the tool input
    const input = toolState.input as { questions?: Array<{ question?: string }> };
    const questionText = input.questions?.[0]?.question || "OpenCode is waiting for your input";

    // Create a unique key for this question call to avoid duplicate notifications
    // We use a hash of the question text since we don't have callID in this context
    const questionKey = `${sessionID}:${questionText.slice(0, 100)}`;
    if (notifiedQuestions.has(questionKey)) {
      return;
    }

    console.log(`Question tool invoked in session ${sessionID}, sending notification...`);

    // Fetch session info
    const sessionInfo = await sseClient.fetchSessionInfo(sessionID, directory);

    // Skip subagent sessions
    if (sessionInfo?.parentSessionID) {
      console.log(`Session ${sessionID} is a subagent, skipping question notification`);
      knownSubagents.add(sessionID);
      return;
    }

    // Mark as notified
    notifiedQuestions.set(questionKey, Date.now());

    const notification: Notification = {
      type: "question",
      sessionId: sessionID,
      sessionTitle: sessionInfo?.title || sessionID,
      projectId: sessionInfo?.projectID || "",
      projectDirectory: directory,
      desktopUrl: buildDesktopUrl(config.opencode.desktopBaseUrl, sessionInfo?.projectID || "", sessionID),
      timestamp: new Date(),
      question: questionText,
    };

    await notifier.send(notification);
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    sseClient.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Starting oc-notifier...");
  await sseClient.start();
}

function buildDesktopUrl(baseUrl: string, projectId: string, sessionId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${projectId}/session/${sessionId}`;
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
