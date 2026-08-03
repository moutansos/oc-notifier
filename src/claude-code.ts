/**
 * Map Claude Code hook payloads to oc-notifier Notification objects.
 * The Claude Code plugin forwards hook JSON as-is; this module normalizes it.
 */

import type { Notification, NotificationChoice } from "./providers/types.ts";

/** Claude Code hook events we care about */
export type ClaudeCodeHookEventName =
  | "Notification"
  | "PermissionRequest"
  | "Stop"
  | "SubagentStop";

export interface ClaudeCodeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  // Notification
  message?: string;
  title?: string;
  notification_type?: string;
  // PermissionRequest / PreToolUse-style
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: unknown[];
  // Stop
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

/**
 * Convert a Claude Code hook payload into a Notification, or null if it
 * should be ignored (unknown event, subagent, unsupported notification type).
 */
export function mapClaudeCodeHook(payload: ClaudeCodeHookPayload): Notification | null {
  // Skip subagent events (agent_id present means we're inside a subagent)
  if (payload.agent_id) {
    return null;
  }

  const sessionId = payload.session_id || "unknown";
  const projectDirectory = payload.cwd || "";
  const projectName = projectDirectory.split("/").filter(Boolean).pop() || projectDirectory || "Claude Code";
  const base = {
    source: "claude-code" as const,
    sessionId,
    sessionTitle: projectName,
    projectId: "",
    projectDirectory,
    desktopUrl: "",
    timestamp: new Date(),
  };

  const eventName = payload.hook_event_name;

  if (eventName === "Notification") {
    return mapNotificationEvent(payload, base);
  }

  if (eventName === "PermissionRequest") {
    return mapPermissionRequestEvent(payload, base);
  }

  if (eventName === "Stop") {
    // Stop fires when Claude finishes responding — treat as idle/ready for input.
    // SubagentStop is excluded by agent_id check above; bare Stop is main thread.
    return {
      ...base,
      type: "idle",
    };
  }

  return null;
}

function mapNotificationEvent(
  payload: ClaudeCodeHookPayload,
  base: Omit<Notification, "type">
): Notification | null {
  const notificationType = payload.notification_type ?? "";

  switch (notificationType) {
    case "idle_prompt":
    case "agent_completed":
      return { ...base, type: "idle" };

    case "permission_prompt":
    case "agent_needs_input":
      return {
        ...base,
        type: "permission",
        permissionTitle: payload.message || payload.title || "Permission required",
        permissionType: "permission",
        choices: [
          { label: "Once", description: "Approve just this request" },
          { label: "Always", description: "Approve future matching requests" },
          { label: "Reject", description: "Deny the request" },
        ],
      };

    case "elicitation_dialog":
      return {
        ...base,
        type: "question",
        question: payload.message || payload.title || "Claude Code is waiting for input",
      };

    // Ignore auth_success, elicitation_complete, elicitation_response, etc.
    default:
      return null;
  }
}

function mapPermissionRequestEvent(
  payload: ClaudeCodeHookPayload,
  base: Omit<Notification, "type">
): Notification | null {
  const toolName = payload.tool_name || "tool";
  const toolInput = payload.tool_input ?? {};

  // AskUserQuestion → question notification with choices
  if (toolName === "AskUserQuestion") {
    return mapAskUserQuestion(toolInput, base);
  }

  // All other permission prompts → permission notification
  const permissionTitle = formatPermissionTitle(toolName, toolInput);
  const choices = buildPermissionChoices(payload.permission_suggestions);

  return {
    ...base,
    type: "permission",
    permissionTitle,
    permissionType: toolName,
    choices,
  };
}

function mapAskUserQuestion(
  toolInput: Record<string, unknown>,
  base: Omit<Notification, "type">
): Notification {
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const parts: string[] = [];
  const choices: NotificationChoice[] = [];

  for (const item of questions) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const questionText = typeof q.question === "string" ? q.question : "Question";
    const header = typeof q.header === "string" ? q.header : undefined;
    parts.push(header ? `${header}: ${questionText}` : questionText);

    if (Array.isArray(q.options)) {
      for (const option of q.options) {
        if (typeof option !== "object" || option === null) continue;
        const opt = option as Record<string, unknown>;
        choices.push({
          label: typeof opt.label === "string" ? opt.label : "Option",
          description: typeof opt.description === "string" ? opt.description : undefined,
        });
      }
    }
  }

  return {
    ...base,
    type: "question",
    question: parts.length > 0 ? parts.join("\n\n") : "Claude Code is waiting for your response",
    choices: choices.length > 0 ? choices : undefined,
  };
}

function formatPermissionTitle(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    const command = toolInput.command;
    const truncated = command.length > 120 ? command.slice(0, 117) + "..." : command;
    return `Bash: ${truncated}`;
  }

  if ((toolName === "Edit" || toolName === "Write" || toolName === "Read") &&
      typeof toolInput.file_path === "string") {
    return `${toolName}: ${toolInput.file_path}`;
  }

  if (typeof toolInput.description === "string" && toolInput.description) {
    return `${toolName}: ${toolInput.description}`;
  }

  return toolName;
}

function buildPermissionChoices(suggestions: unknown[] | undefined): NotificationChoice[] {
  const choices: NotificationChoice[] = [
    { label: "Once", description: "Approve just this request" },
  ];

  if (Array.isArray(suggestions) && suggestions.length > 0) {
    choices.push({
      label: "Always",
      description: "Approve future matching requests",
    });
  } else {
    choices.push({
      label: "Always",
      description: "Approve future matching requests for this session",
    });
  }

  choices.push({ label: "Reject", description: "Deny the request" });
  return choices;
}
