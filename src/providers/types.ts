/**
 * Provider interface and notification types
 */

import { hostname as osHostname } from "node:os";

export type NotificationType = "idle" | "question" | "permission";

/** Origin of the notification event */
export type NotificationSource =
  | "opencode"
  | "claude-code"
  | "grok-code"
  | "codex"
  | "copilot-cli";

export interface NotificationChoice {
  label: string;
  description?: string;
}

export interface Notification {
  type: NotificationType;
  /** Where the event came from (defaults to "opencode") */
  source?: NotificationSource;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectDirectory: string;
  /** Deep link or related URL; may be empty when no UI link is available */
  desktopUrl: string;
  timestamp: Date;
  /**
   * Origin machine hostname (short form preferred). Preserved across parent
   * forwarding so centralized providers still show the child instance host.
   */
  hostname?: string;
  /**
   * Number of parent-provider hops already taken. Incremented on each forward;
   * used to reject cycles / runaway nesting.
   */
  hops?: number;
  /** Question text when type is "question" */
  question?: string;
  /** Permission title when type is "permission" (e.g. "Edit src/index.ts") */
  permissionTitle?: string;
  /** Permission type when type is "permission" (e.g. "edit", "bash", "webfetch") */
  permissionType?: string;
  /** Available response choices shown for question/permission prompts */
  choices?: NotificationChoice[];
}

export interface NotificationProvider {
  readonly type: string;
  readonly enabled: boolean;
  send(notification: Notification): Promise<void>;
}

/** Display name for the notification source */
export function sourceLabel(source: NotificationSource | undefined): string {
  switch (source) {
    case "claude-code":
      return "Claude Code";
    case "grok-code":
      return "Grok";
    case "codex":
      return "Codex";
    case "copilot-cli":
      return "Copilot CLI";
    default:
      return "OpenCode";
  }
}

/**
 * Short hostname for display (strip domain): "host.local" → "host".
 * Prefer an already-set notification hostname so parent instances keep the child host.
 */
export function displayHostname(hostname?: string): string {
  const raw = (hostname && hostname.trim()) || osHostname() || "unknown";
  return raw.split(".")[0] || raw || "unknown";
}

/** Local short hostname for stamping new notifications. */
export function localHostname(): string {
  return displayHostname();
}
