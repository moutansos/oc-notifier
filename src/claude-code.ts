/**
 * Map Claude Code hook payloads to oc-notifier Notification objects.
 * The Claude Code plugin forwards hook JSON as-is; this module normalizes it.
 *
 * Hooks do not include the session title. Claude Code appends it to the
 * transcript JSONL at `transcript_path` (`custom-title` from `/rename`,
 * `ai-title` otherwise). We read that on notify so Discord/Teams show it.
 */

import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { Notification, NotificationChoice } from "./providers/types.ts";

/** Claude Code hook events we care about */
export type ClaudeCodeHookEventName =
  | "Notification"
  | "PermissionRequest"
  | "Stop"
  | "StopFailure"
  | "SubagentStop";

export interface ClaudeCodeBackgroundTask {
  type?: string;
  status?: string;
}

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
  background_tasks?: unknown[];
  session_crons?: unknown[];
  error?: string;
  error_details?: string;
}

const finishedTaskStatuses = new Set([
  "completed",
  "failed",
  "killed",
  "cancelled",
  "canceled",
  "stopped",
]);

const taskTypesAliveUntilShutdown = new Set(["teammate"]);

/** Transcript title records, highest precedence first. */
const titleRecords = [
  { type: "custom-title", field: "customTitle" },
  { type: "ai-title", field: "aiTitle" },
  { type: "summary", field: "summary" },
] as const;

/**
 * Claude Code re-appends title metadata every 32 KiB of transcript and reads it
 * back from the last 64 KiB, so a tail read always sees the latest title.
 */
export const transcriptTailBytes = 128 * 1024;

export function activeBackgroundTasks(payload: ClaudeCodeHookPayload): ClaudeCodeBackgroundTask[] {
  if (!Array.isArray(payload.background_tasks)) {
    return [];
  }

  const active: ClaudeCodeBackgroundTask[] = [];
  for (const item of payload.background_tasks) {
    const task = asBackgroundTask(item);
    if (task.type && taskTypesAliveUntilShutdown.has(task.type.toLowerCase())) continue;
    if (task.status && finishedTaskStatuses.has(task.status.toLowerCase())) continue;
    active.push(task);
  }
  return active;
}

export function describeBackgroundTasks(tasks: ClaudeCodeBackgroundTask[]): string {
  return tasks.map((task) => (task.type || "task").replace(/\s+/g, "_")).join(",");
}

function asBackgroundTask(item: unknown): ClaudeCodeBackgroundTask {
  if (typeof item !== "object" || item === null) {
    return {};
  }
  const obj = item as Record<string, unknown>;
  return {
    type: typeof obj.type === "string" ? obj.type : undefined,
    status: typeof obj.status === "string" ? obj.status : undefined,
  };
}

/**
 * Convert a Claude Code hook payload into a Notification, or null if it
 * should be ignored (unknown event, subagent, unsupported notification type).
 */
export async function mapClaudeCodeHook(payload: ClaudeCodeHookPayload): Promise<Notification | null> {
  const notification = classifyClaudeCodeHook(payload);
  // StopFailure keeps the API error as its title.
  if (!notification || payload.hook_event_name === "StopFailure") {
    return notification;
  }

  const title = await readClaudeCodeSessionTitle(payload.transcript_path, payload.session_id);
  if (title) {
    notification.sessionTitle = title;
  }
  return notification;
}

/**
 * Read the session title from a Claude Code transcript. The last record of each
 * type wins; `custom-title` beats `ai-title`, which beats a legacy `summary`.
 * Fail-open: a missing or unreadable transcript leaves the project-name fallback.
 */
export async function readClaudeCodeSessionTitle(
  transcriptPath: string | undefined,
  sessionId: string | undefined
): Promise<string | undefined> {
  if (!isTranscriptPathFor(transcriptPath, sessionId)) {
    return undefined;
  }

  try {
    const info = await stat(transcriptPath);
    if (!info.isFile()) {
      return undefined;
    }

    // Start one byte early so a window that begins on a line boundary keeps that line.
    const start = Math.max(0, info.size - transcriptTailBytes - 1);
    const lines = (await Bun.file(transcriptPath).slice(start).text()).split("\n");
    if (start > 0) {
      // Partial (or empty) first line.
      lines.shift();
    }

    const latest = new Map<string, string>();
    for (const line of lines) {
      const record = titleRecords.find((r) => line.includes(`"type":"${r.type}"`));
      if (!record) continue;

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;

      const obj = entry as Record<string, unknown>;
      if (obj.type !== record.type) continue;
      if (typeof obj.sessionId === "string" && obj.sessionId !== sessionId) continue;

      const value = obj[record.field];
      if (typeof value === "string") {
        // An empty custom-title means the user cleared their /rename.
        latest.set(record.type, value.trim());
      }
    }

    for (const record of titleRecords) {
      const title = latest.get(record.type);
      if (title) {
        return title;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * `transcript_path` comes from the request body, so only accept what Claude Code
 * writes: an absolute `<session_id>.jsonl`. UNC paths would open SMB connections on Windows.
 */
function isTranscriptPathFor(
  transcriptPath: string | undefined,
  sessionId: string | undefined
): transcriptPath is string {
  return (
    typeof transcriptPath === "string" &&
    typeof sessionId === "string" &&
    sessionId !== "" &&
    isAbsolute(transcriptPath) &&
    !/^[\\/]{2}/.test(transcriptPath) &&
    basename(transcriptPath) === `${sessionId}.jsonl`
  );
}

function classifyClaudeCodeHook(payload: ClaudeCodeHookPayload): Notification | null {
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
    const pausedForBackgroundWork = activeBackgroundTasks(payload).length > 0;
    if (pausedForBackgroundWork) {
      return null;
    }

    return {
      ...base,
      type: "idle",
    };
  }

  if (eventName === "StopFailure") {
    return {
      ...base,
      sessionTitle: `API error: ${payload.error || "unknown"}`,
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
    // idle_prompt is deliberately absent: Claude Code fires it ~60s after the
    // Stop hook for the same session, which would double-notify every turn.
    // Stop is the idle signal because it lands immediately.
    case "agent_completed":
      return { ...base, type: "idle" };

    // permission_prompt is likewise absent: it is the desktop-alert twin of the
    // PermissionRequest hook, which carries the tool name and input.
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
