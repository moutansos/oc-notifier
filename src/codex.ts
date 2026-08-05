/**
 * Map Codex CLI hook payloads to oc-notifier Notification objects.
 *
 * Codex uses snake_case stdin fields similar to Claude Code, with a few
 * Codex-specific extensions (model, turn_id, permission_mode, …).
 *
 * Events we map:
 * - Stop → idle (turn finished; ready for input)
 * - PermissionRequest → permission (approval UI about to appear)
 *
 * We deliberately do not auto-approve/deny PermissionRequest — the forwarder
 * returns no decision so Codex's normal approval flow continues.
 *
 * @see https://learn.chatgpt.com/codex/hooks
 */

import type { Notification, NotificationChoice } from "./providers/types.ts";

export interface CodexHookPayload {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  turn_id?: string;
  permission_mode?: string;
  // Stop
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  // PermissionRequest / PreToolUse-style
  tool_name?: string;
  tool_input?: Record<string, unknown> | unknown;
  tool_use_id?: string;
  // Subagent fields (if ever present on main-thread hooks)
  agent_id?: string;
  agent_type?: string;
}

/**
 * Convert a Codex hook payload into a Notification, or null if ignored.
 */
export function mapCodexHook(payload: CodexHookPayload): Notification | null {
  // Subagent-scoped events should not notify the main-session user channel.
  // Main-thread hooks use the parent session_id and typically omit agent_id.
  if (payload.agent_id) {
    return null;
  }

  const sessionId = payload.session_id || "unknown";
  const projectDirectory = payload.cwd || "";
  const projectName =
    projectDirectory.split("/").filter(Boolean).pop() ||
    projectDirectory ||
    "Codex";
  const base = {
    source: "codex" as const,
    sessionId,
    sessionTitle: projectName,
    projectId: "",
    projectDirectory,
    desktopUrl: "",
    timestamp: new Date(),
  };

  const eventName = normalizeEventName(payload.hook_event_name || "");

  if (eventName === "stop") {
    // stop_hook_active means Codex already continued once from a Stop hook.
    // Still treat the subsequent stop as idle (user-visible turn end).
    return { ...base, type: "idle" };
  }

  if (eventName === "permissionrequest" || eventName === "permission_request") {
    return mapPermissionRequest(payload, base);
  }

  return null;
}

export function summarizeCodexPayload(payload: CodexHookPayload): string {
  const event = payload.hook_event_name ?? "?";
  const tool = payload.tool_name ?? "-";
  const mode = payload.permission_mode ?? "-";
  const stopActive = payload.stop_hook_active === true ? "true" : "false";
  return `event=${event} tool=${tool} permission_mode=${mode} stop_hook_active=${stopActive}`;
}

function normalizeEventName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

function mapPermissionRequest(
  payload: CodexHookPayload,
  base: Omit<Notification, "type">
): Notification {
  const toolName = payload.tool_name || "tool";
  const toolInput = asRecord(payload.tool_input);
  const permissionTitle = formatPermissionTitle(toolName, toolInput);

  return {
    ...base,
    type: "permission",
    permissionTitle,
    permissionType: toolName,
    choices: defaultPermissionChoices(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatPermissionTitle(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  // Bash / shell: tool_input.command is the shell string
  if (
    typeof toolInput.command === "string" &&
    (toolName === "Bash" ||
      toolName === "bash" ||
      /shell|terminal|exec/i.test(toolName))
  ) {
    const command = toolInput.command;
    const truncated = command.length > 120 ? command.slice(0, 117) + "..." : command;
    return `Bash: ${truncated}`;
  }

  // apply_patch also uses tool_input.command (patch text)
  if (
    typeof toolInput.command === "string" &&
    (toolName === "apply_patch" ||
      toolName === "Edit" ||
      toolName === "Write")
  ) {
    const description =
      typeof toolInput.description === "string" ? toolInput.description : undefined;
    if (description) {
      return `${toolName}: ${description}`;
    }
    return `${toolName} (file edit)`;
  }

  if (typeof toolInput.description === "string" && toolInput.description) {
    return `${toolName}: ${toolInput.description}`;
  }

  const filePath =
    (typeof toolInput.file_path === "string" && toolInput.file_path) ||
    (typeof toolInput.path === "string" && toolInput.path) ||
    undefined;
  if (filePath) {
    return `${toolName}: ${filePath}`;
  }

  return toolName;
}

function defaultPermissionChoices(): NotificationChoice[] {
  return [
    { label: "Once", description: "Approve just this request" },
    { label: "Always", description: "Approve future matching requests" },
    { label: "Reject", description: "Deny the request" },
  ];
}
