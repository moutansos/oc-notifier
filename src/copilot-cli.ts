/**
 * Map GitHub Copilot CLI hook payloads to oc-notifier Notification objects.
 *
 * Copilot hooks accept camelCase event names (agentStop, permissionRequest,
 * notification) with camelCase fields, or PascalCase / VS Code-compatible
 * names (Stop, PermissionRequest, Notification) with snake_case fields.
 *
 * Events we map (user-waiting signals):
 * - agentStop / Stop → idle (main agent finished a turn)
 * - notification / permission_prompt → permission (CLI is showing a permission UI)
 * - notification / elicitation_dialog → question (CLI is waiting for input)
 * - permissionRequest → permission (optional; richer toolName/toolArgs, but fires
 *   *before* auto-allow rules — see notes in mapPermissionRequest)
 *
 * Default install hooks notification (permission_prompt|elicitation_dialog) and
 * agentStop only, so auto-approved tools do not spam. permissionRequest is still
 * accepted on the ingest endpoint for manual clients.
 *
 * The forwarder must not write allow/deny JSON to stdout (empty = fall through).
 *
 * @see https://docs.github.com/en/copilot/reference/hooks-reference
 */

import type { Notification, NotificationChoice } from "./providers/types.ts";

export interface CopilotCliHookPayload {
  // camelCase (native Copilot CLI)
  sessionId?: string;
  timestamp?: number | string;
  cwd?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolInput?: Record<string, unknown> | unknown;
  transcriptPath?: string;
  stopReason?: string;
  stop_hook_active?: boolean;
  message?: string;
  title?: string;
  notification_type?: string;
  notificationType?: string;
  agentId?: string;
  agentType?: string;
  // snake_case / VS Code compatible
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | unknown;
  transcript_path?: string;
  stop_reason?: string;
  agent_id?: string;
  agent_type?: string;
  // Some payloads may include an explicit event name field
  hookEventName?: string;
}

/**
 * Convert a Copilot CLI hook payload into a Notification, or null if ignored.
 */
export function mapCopilotCliHook(payload: CopilotCliHookPayload): Notification | null {
  // Subagent-scoped events should not notify on the main-session channel.
  if (payload.agentId || payload.agent_id) {
    return null;
  }

  const sessionId = payload.sessionId || payload.session_id || "unknown";
  const projectDirectory = payload.cwd || "";
  const projectName =
    projectDirectory.split("/").filter(Boolean).pop() ||
    projectDirectory ||
    "Copilot CLI";
  const base = {
    source: "copilot-cli" as const,
    sessionId,
    sessionTitle: projectName,
    projectId: "",
    projectDirectory,
    desktopUrl: "",
    timestamp: new Date(),
  };

  const eventName = normalizeEventName(
    payload.hookEventName || payload.hook_event_name || inferEventName(payload)
  );

  if (
    eventName === "agentstop" ||
    eventName === "agent_stop" ||
    eventName === "stop"
  ) {
    return { ...base, type: "idle" };
  }

  if (eventName === "notification") {
    return mapNotificationEvent(payload, base);
  }

  // Optional path: richer tool details, but fires before auto-allow/auto-deny.
  // Prefer notification/permission_prompt for "user is waiting" fidelity.
  if (
    eventName === "permissionrequest" ||
    eventName === "permission_request"
  ) {
    return mapPermissionRequest(payload, base);
  }

  return null;
}

export function summarizeCopilotPayload(payload: CopilotCliHookPayload): string {
  const inferred = inferEventName(payload);
  const event =
    payload.hookEventName ?? payload.hook_event_name ?? (inferred || "?");
  const tool = payload.toolName ?? payload.tool_name ?? "-";
  const ntype =
    payload.notificationType ?? payload.notification_type ?? "-";
  const msg = (payload.message || payload.title || "").slice(0, 80);
  return `event=${event} tool=${tool} notificationType=${ntype} msg=${JSON.stringify(msg)}`;
}

/**
 * When the hook config uses camelCase event names, stdin often omits
 * hook_event_name. Infer from distinctive fields.
 */
function inferEventName(payload: CopilotCliHookPayload): string {
  if (payload.notification_type || payload.notificationType) {
    return "notification";
  }
  if (
    payload.toolName ||
    payload.tool_name ||
    payload.toolArgs !== undefined ||
    payload.tool_input !== undefined ||
    payload.toolInput !== undefined
  ) {
    // permissionRequest and preToolUse look similar; install only registers
    // permissionRequest so treat tool-bearing payloads as permission prompts.
    return "permissionRequest";
  }
  if (
    payload.stopReason ||
    payload.stop_reason ||
    payload.transcriptPath ||
    payload.transcript_path ||
    payload.stop_hook_active !== undefined
  ) {
    return "agentStop";
  }
  return "";
}

function normalizeEventName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

/**
 * Map permissionRequest payloads. Note: this hook runs *before* rules,
 * session approvals, and auto-allow/auto-deny — empty hook output still
 * falls through, so many calls never show a UI. Prefer permission_prompt
 * notifications for "user is waiting" unless you need toolArgs detail.
 */
function mapPermissionRequest(
  payload: CopilotCliHookPayload,
  base: Omit<Notification, "type">
): Notification {
  const toolName = payload.toolName || payload.tool_name || "tool";
  const toolInput = asRecord(
    payload.toolArgs ?? payload.toolInput ?? payload.tool_input
  );

  // ask_user / AskUserQuestion → question notification
  if (
    toolName === "ask_user" ||
    toolName === "AskUserQuestion" ||
    /ask.?user/i.test(toolName)
  ) {
    return mapAskUser(toolInput, base, payload);
  }

  return {
    ...base,
    type: "permission",
    permissionTitle: formatPermissionTitle(toolName, toolInput),
    permissionType: toolName,
    choices: defaultPermissionChoices(),
  };
}

function mapNotificationEvent(
  payload: CopilotCliHookPayload,
  base: Omit<Notification, "type">
): Notification | null {
  const notificationType = (
    payload.notificationType ||
    payload.notification_type ||
    ""
  )
    .toLowerCase()
    .replace(/-/g, "_");

  switch (notificationType) {
    // Primary "user must approve a tool" signal (fires with the system notification).
    case "permission_prompt":
      return {
        ...base,
        type: "permission",
        permissionTitle:
          payload.message ||
          payload.title ||
          "Permission required",
        permissionType: "permission",
        choices: defaultPermissionChoices(),
      };

    case "elicitation_dialog":
      return {
        ...base,
        type: "question",
        question:
          payload.message ||
          payload.title ||
          "Copilot CLI is waiting for your response",
      };

    // agent_completed = background *subagent* finished (not main-turn idle).
    // agent_idle = background agent waiting on write_agent.
    // shell_* = background shell job completion noise.
    case "agent_completed":
    case "agent_idle":
    case "shell_completed":
    case "shell_detached_completed":
    default:
      return null;
  }
}

function mapAskUser(
  toolInput: Record<string, unknown>,
  base: Omit<Notification, "type">,
  payload: CopilotCliHookPayload
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
          description:
            typeof opt.description === "string" ? opt.description : undefined,
        });
      }
    }
  }

  if (parts.length === 0) {
    const prompt =
      (typeof toolInput.prompt === "string" && toolInput.prompt) ||
      (typeof toolInput.question === "string" && toolInput.question) ||
      payload.message ||
      payload.title ||
      "Copilot CLI is waiting for your response";
    return {
      ...base,
      type: "question",
      question: prompt,
      choices: choices.length > 0 ? choices : undefined,
    };
  }

  return {
    ...base,
    type: "question",
    question: parts.join("\n\n"),
    choices: choices.length > 0 ? choices : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { command: value };
    }
    return {};
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatPermissionTitle(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const command =
    typeof toolInput.command === "string" ? toolInput.command : undefined;
  if (
    command &&
    (toolName === "bash" ||
      toolName === "Bash" ||
      toolName === "powershell" ||
      /shell|terminal|exec/i.test(toolName))
  ) {
    const truncated =
      command.length > 120 ? command.slice(0, 117) + "..." : command;
    return `Bash: ${truncated}`;
  }

  const filePath =
    (typeof toolInput.file_path === "string" && toolInput.file_path) ||
    (typeof toolInput.path === "string" && toolInput.path) ||
    (typeof toolInput.target_file === "string" && toolInput.target_file) ||
    undefined;
  if (filePath) {
    return `${toolName}: ${filePath}`;
  }

  if (typeof toolInput.description === "string" && toolInput.description) {
    return `${toolName}: ${toolInput.description}`;
  }

  // Copilot create/edit may use path-like fields under different names
  if (typeof toolInput.filePath === "string" && toolInput.filePath) {
    return `${toolName}: ${toolInput.filePath}`;
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
