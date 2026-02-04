/**
 * oc-notifier - CLI entry point
 *
 * Connects to an OpenCode server's SSE stream and sends push notifications
 * when sessions transition to idle state.
 */

import { parseArgs } from "util";
import { loadConfig } from "./config.ts";
import { SSEClient } from "./sse-client.ts";
import { createProviders, type Notification } from "./providers/index.ts";
import { Notifier } from "./notifier.ts";

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
  const previousStatus = new Map<string, string>();

  // Handle session status events (from all projects via /global/event)
  sseClient.onSessionStatus(async (event, directory) => {
    const { sessionID, status } = event.properties;
    const prevStatus = previousStatus.get(sessionID);
    const currentStatus = status.type;

    // Update tracked status
    previousStatus.set(sessionID, currentStatus);

    // Only notify when transitioning TO idle (not on initial idle)
    if (currentStatus === "idle" && prevStatus && prevStatus !== "idle") {
      console.log(`Session ${sessionID} transitioned to idle (project: ${directory})`);

      // Fetch session info for richer notification
      const sessionInfo = await sseClient.fetchSessionInfo(sessionID);

      const notification: Notification = {
        sessionId: sessionID,
        sessionTitle: sessionInfo?.title || sessionID,
        projectId: sessionInfo?.projectID || "",
        projectDirectory: directory,
        desktopUrl: buildDesktopUrl(config.opencode.desktopBaseUrl, sessionInfo?.projectID || "", sessionID),
        timestamp: new Date(),
      };

      await notifier.send(notification);
    } else if (currentStatus !== "idle") {
      console.log(`Session ${sessionID} status: ${currentStatus} (project: ${directory})`);
    }
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
