/**
 * Map Grok Build hook payloads to oc-notifier Notification objects.
 *
 * Grok stdin uses camelCase (sessionId, hookEventName, …) unlike Claude snake_case.
 *
 * Important limits (see PR review / Grok docs):
 * - There is no Claude-style PermissionRequest hook. PermissionDenied is a *deny*
 *   outcome from the permission system, not "please approve".
 * - Notification "type" strings are not fully documented by Grok; we keep a narrow
 *   allowlist and ignore unknown types (same default as Claude mapping) so monitor
 *   line spam does not become fake permission alerts.
 * - Observed real types are logged at ingest so the allowlist can be refined.
 * - Hooks do not include the session title. Grok stores it in
 *   `$GROK_HOME/sessions/<urlencoded-cwd>/<sessionId>/summary.json`
 *   (`generated_title`). We read that on notify so Discord/Teams show it.
 *
 * @see ~/.grok/docs/user-guide/10-hooks.md
 * @see ~/.grok/docs/user-guide/17-sessions.md
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Notification, NotificationChoice } from "./providers/types.ts";

export interface GrokCodeHookPayload {
  sessionId?: string;
  hookEventName?: string;
  cwd?: string;
  workspaceRoot?: string;
  permissionMode?: string;
  message?: string;
  notificationMessage?: string;
  title?: string;
  notificationType?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
  reason?: string;
  // snake_case aliases
  session_id?: string;
  hook_event_name?: string;
  notification_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * Candidate notification types (not fully documented by Grok).
 * Keep narrow; expand only after seeing them in ingest logs.
 */
const permissionNotificationTypes = new Set([
  "permission_prompt",
  "approval_required",
  "needs_input",
  "agent_needs_input",
]);

const idleNotificationTypes = new Set([
  "idle_prompt",
  "idle",
  "agent_completed",
  "turn_complete",
]);

const questionNotificationTypes = new Set([
  "elicitation_dialog",
  "question",
]);

export interface MapGrokCodeHookOptions {
  /** Override `$GROK_HOME` / `~/.grok` (tests). */
  grokHome?: string;
}

/**
 * Convert a Grok hook payload into a Notification, or null if ignored.
 */
export async function mapGrokCodeHook(
  payload: GrokCodeHookPayload,
  options?: MapGrokCodeHookOptions
): Promise<Notification | null> {
  const notification = classifyGrokHook(payload);
  if (!notification) {
    return null;
  }

  const title = await readGrokSessionTitle(
    notification.sessionId,
    notification.projectDirectory,
    options?.grokHome
  );
  if (title) {
    notification.sessionTitle = title;
  }
  return notification;
}

function classifyGrokHook(payload: GrokCodeHookPayload): Notification | null {
  const sessionId = payload.sessionId || payload.session_id || "unknown";
  const projectDirectory = payload.cwd || payload.workspaceRoot || "";
  const projectName =
    projectDirectory.split("/").filter(Boolean).pop() ||
    projectDirectory ||
    "Grok";
  const base = {
    source: "grok-code" as const,
    sessionId,
    sessionTitle: projectName,
    projectId: "",
    projectDirectory,
    desktopUrl: "",
    timestamp: new Date(),
  };

  const eventName = normalizeEventName(
    payload.hookEventName || payload.hook_event_name || ""
  );

  if (eventName === "notification") {
    return mapNotificationEvent(payload, base);
  }

  if (eventName === "stop") {
    // Session-end observe fires (channel_closed / shutdown) should not notify.
    const reason = payload.reason ?? "";
    if (reason && reason !== "end_turn") {
      return null;
    }
    return { ...base, type: "idle" };
  }

  // Permission *system* denied a call (deny rule) — not a user approval prompt.
  if (eventName === "permissiondenied" || eventName === "permission_denied") {
    return buildPermissionNotification(payload, base, {
      fallbackTitle: "Permission denied",
      denied: true,
    });
  }

  return null;
}

/**
 * Read Grok's on-disk session title (`generated_title` in summary.json).
 * Fail-open: missing files or unreadable JSON leave the project-name fallback.
 */
export async function readGrokSessionTitle(
  sessionId: string,
  cwd: string,
  grokHome?: string
): Promise<string | undefined> {
  if (!sessionId || sessionId === "unknown" || !isSafeSessionId(sessionId)) {
    return undefined;
  }

  try {
    const home = resolveGrokHome(grokHome);
    const sessionsRoot = join(home, "sessions");

    const candidates: string[] = [];
    if (cwd) {
      const trimmed = cwd.replace(/[\\/]+$/, "") || cwd;
      candidates.push(
        join(sessionsRoot, encodeURIComponent(trimmed), sessionId, "summary.json")
      );
      if (!cwd.endsWith("/") && !cwd.endsWith("\\")) {
        candidates.push(
          join(
            sessionsRoot,
            encodeURIComponent(`${trimmed}/`),
            sessionId,
            "summary.json"
          )
        );
      }
    }

    for (const path of candidates) {
      const title = await titleFromSummary(path);
      if (title) {
        return title;
      }
    }

    // Encoded cwd > 255 bytes uses a slug+hash group; find by session id.
    const glob = new Bun.Glob(`*/${sessionId}/summary.json`);
    for await (const rel of glob.scan({ cwd: sessionsRoot, onlyFiles: true })) {
      const title = await titleFromSummary(join(sessionsRoot, rel));
      if (title) {
        return title;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveGrokHome(override?: string): string {
  if (override && override.trim()) {
    return override.trim();
  }
  const env = process.env.GROK_HOME?.trim();
  if (env) {
    return env;
  }
  return join(homedir(), ".grok");
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId);
}

async function titleFromSummary(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return undefined;
  }
  try {
    const data = (await file.json()) as Record<string, unknown>;
    const generated =
      typeof data.generated_title === "string" ? data.generated_title.trim() : "";
    if (generated) {
      return generated;
    }
    const summary =
      typeof data.session_summary === "string" ? data.session_summary.trim() : "";
    if (summary) {
      return summary;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function summarizeGrokPayload(payload: GrokCodeHookPayload): string {
  const event = payload.hookEventName ?? payload.hook_event_name ?? "?";
  const ntype = payload.notificationType ?? payload.notification_type ?? "-";
  const reason = payload.reason ?? "-";
  const tool = payload.toolName ?? payload.tool_name ?? "-";
  const msg = (
    payload.message ||
    payload.notificationMessage ||
    payload.title ||
    ""
  ).slice(0, 80);
  return `event=${event} notificationType=${ntype} reason=${reason} tool=${tool} msg=${JSON.stringify(msg)}`;
}

function normalizeEventName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

function mapNotificationEvent(
  payload: GrokCodeHookPayload,
  base: Omit<Notification, "type">
): Notification | null {
  const msg = notificationMessage(payload);
  const notificationType = (
    payload.notificationType ||
    payload.notification_type ||
    ""
  )
    .toLowerCase()
    .replace(/-/g, "_");

  // Idle / turn-complete style — Stop covers turn end; avoid doubles
  if (
    idleNotificationTypes.has(notificationType) ||
    /waiting for your input/i.test(msg)
  ) {
    return null;
  }

  // Explicit permission / approval candidates (vocabulary still provisional)
  if (permissionNotificationTypes.has(notificationType)) {
    return buildPermissionNotification(payload, base, {
      fallbackTitle: msg || "Permission required",
    });
  }

  if (questionNotificationTypes.has(notificationType)) {
    return {
      ...base,
      type: "question",
      question: msg || "Grok is waiting for your response",
    };
  }

  // Unknown / informational notifications (auth_success, monitor lines, …):
  // match Claude — ignore rather than invent a fake permission dialog.
  return null;
}

function buildPermissionNotification(
  payload: GrokCodeHookPayload,
  base: Omit<Notification, "type">,
  options: { fallbackTitle: string; denied?: boolean }
): Notification {
  const toolName = payload.toolName || payload.tool_name || "";
  const toolInput = payload.toolInput || payload.tool_input || {};
  const msg = notificationMessage(payload);

  let permissionTitle = options.fallbackTitle;
  if (toolName) {
    const fromTool = formatPermissionTitle(toolName, toolInput);
    permissionTitle = msg ? `${fromTool}\n${msg}` : fromTool;
    if (options.denied) {
      permissionTitle = `Denied: ${permissionTitle}`;
    }
  } else if (options.denied && !/^denied/i.test(permissionTitle)) {
    permissionTitle = `Denied: ${permissionTitle}`;
  }

  return {
    ...base,
    type: "permission",
    permissionTitle,
    permissionType: toolName || (options.denied ? "denied" : "permission"),
    choices: options.denied ? undefined : defaultPermissionChoices(),
  };
}

function notificationMessage(payload: GrokCodeHookPayload): string {
  return (
    payload.message ||
    payload.notificationMessage ||
    payload.title ||
    ""
  );
}

/**
 * Best-effort tool title. Grok tool schemas are not fully documented here;
 * try common field names used by both Grok and Claude-style tools.
 */
function formatPermissionTitle(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const command =
    typeof toolInput.command === "string" ? toolInput.command : undefined;
  if (
    command &&
    (toolName === "run_terminal_command" ||
      toolName === "Bash" ||
      /bash|shell|terminal/i.test(toolName))
  ) {
    const truncated = command.length > 120 ? command.slice(0, 117) + "..." : command;
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

  return toolName;
}

function defaultPermissionChoices(): NotificationChoice[] {
  return [
    { label: "Once", description: "Approve just this request" },
    { label: "Always", description: "Approve future matching requests" },
    { label: "Reject", description: "Deny the request" },
  ];
}
