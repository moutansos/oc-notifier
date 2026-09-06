/**
 * HTTP ingest server for external notification sources
 * (Claude Code / Grok / Codex / Copilot CLI hooks).
 *
 * Endpoints:
 *   POST /v1/notify              — normalized notification payload
 *   POST /v1/claude-code/hook    — raw Claude Code hook JSON (forwarded as-is)
 *   POST /v1/grok-code/hook      — raw Grok Build hook JSON (forwarded as-is)
 *   POST /v1/codex/hook          — raw Codex CLI hook JSON (forwarded as-is)
 *   POST /v1/copilot-cli/hook    — raw Copilot CLI hook JSON (forwarded as-is)
 *   GET  /health                 — liveness check
 */

import type { Notification, NotificationChoice, NotificationType } from "./providers/types.ts";
import type { IngestConfig } from "./config.ts";
import { mapClaudeCodeHook, type ClaudeCodeHookPayload } from "./claude-code.ts";
import {
  mapGrokCodeHook,
  summarizeGrokPayload,
  type GrokCodeHookPayload,
} from "./grok-code.ts";
import {
  mapCodexHook,
  summarizeCodexPayload,
  type CodexHookPayload,
} from "./codex.ts";
import {
  mapCopilotCliHook,
  summarizeCopilotPayload,
  type CopilotCliHookPayload,
} from "./copilot-cli.ts";
import type { Notifier } from "./notifier.ts";

export class IngestServer {
  private readonly config: IngestConfig;
  private readonly notifier: Notifier;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(config: IngestConfig, notifier: Notifier) {
    this.config = config;
    this.notifier = notifier;
  }

  start(): void {
    const { host, port } = this.config;

    this.server = Bun.serve({
      hostname: host,
      port,
      fetch: (request) => this.handleRequest(request),
    });

    console.log(`Ingest server listening on http://${host}:${port}`);
    console.log(`  POST /v1/notify`);
    console.log(`  POST /v1/claude-code/hook`);
    console.log(`  POST /v1/grok-code/hook`);
    console.log(`  POST /v1/codex/hook`);
    console.log(`  POST /v1/copilot-cli/hook`);
    console.log(`  GET  /health`);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!this.authorize(request)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (path === "/v1/notify") {
      return this.handleNotify(request);
    }

    if (path === "/v1/claude-code/hook") {
      return this.handleClaudeCodeHook(request);
    }

    if (path === "/v1/grok-code/hook") {
      return this.handleGrokCodeHook(request);
    }

    if (path === "/v1/codex/hook") {
      return this.handleCodexHook(request);
    }

    if (path === "/v1/copilot-cli/hook") {
      return this.handleCopilotCliHook(request);
    }

    return json({ error: "Not found" }, 404);
  }

  private authorize(request: Request): boolean {
    if (!this.config.token) {
      return true;
    }

    const header = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${this.config.token}`;
    return header === expected;
  }

  private async handleNotify(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const notification = parseNotifyBody(body);
      const host = notification.hostname ? ` host=${notification.hostname}` : "";
      console.log(
        `Ingest /v1/notify: type=${notification.type} source=${notification.source ?? "opencode"} session=${notification.sessionId}${host}`
      );
      await this.notifier.send(notification);
      return json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  }

  private async handleClaudeCodeHook(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const payload = body as ClaudeCodeHookPayload;
    const notification = mapClaudeCodeHook(payload);

    if (!notification) {
      console.log(
        `Ingest /v1/claude-code/hook: ignored event=${payload.hook_event_name ?? "?"} type=${payload.notification_type ?? "-"} agent=${payload.agent_id ?? "-"}`
      );
      return json({ ok: true, ignored: true });
    }

    console.log(
      `Ingest /v1/claude-code/hook: type=${notification.type} session=${notification.sessionId} event=${payload.hook_event_name}`
    );
    await this.notifier.send(notification);
    return json({ ok: true });
  }

  private async handleGrokCodeHook(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const payload = body as GrokCodeHookPayload;
    // Log observed types so the allowlist in mapGrokCodeHook can be refined
    // from real traffic (Grok does not document notificationType values).
    console.log(`Ingest /v1/grok-code/hook: raw ${summarizeGrokPayload(payload)}`);

    const notification = await mapGrokCodeHook(payload);
    const eventName = payload.hookEventName ?? payload.hook_event_name ?? "?";

    if (!notification) {
      console.log(
        `Ingest /v1/grok-code/hook: ignored event=${eventName} notificationType=${payload.notificationType ?? payload.notification_type ?? "-"} reason=${payload.reason ?? "-"}`
      );
      return json({ ok: true, ignored: true });
    }

    console.log(
      `Ingest /v1/grok-code/hook: type=${notification.type} session=${notification.sessionId} title=${JSON.stringify(notification.sessionTitle)} event=${eventName}`
    );
    await this.notifier.send(notification);
    return json({ ok: true });
  }

  private async handleCodexHook(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const payload = body as CodexHookPayload;
    console.log(`Ingest /v1/codex/hook: raw ${summarizeCodexPayload(payload)}`);

    const notification = mapCodexHook(payload);
    const eventName = payload.hook_event_name ?? "?";

    if (!notification) {
      console.log(
        `Ingest /v1/codex/hook: ignored event=${eventName} tool=${payload.tool_name ?? "-"} agent=${payload.agent_id ?? "-"}`
      );
      return json({ ok: true, ignored: true });
    }

    console.log(
      `Ingest /v1/codex/hook: type=${notification.type} session=${notification.sessionId} event=${eventName}`
    );
    await this.notifier.send(notification);
    return json({ ok: true });
  }

  private async handleCopilotCliHook(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const payload = body as CopilotCliHookPayload;
    const summary = summarizeCopilotPayload(payload);
    console.log(`Ingest /v1/copilot-cli/hook: raw ${summary}`);

    const notification = mapCopilotCliHook(payload);

    if (!notification) {
      console.log(`Ingest /v1/copilot-cli/hook: ignored ${summary}`);
      return json({ ok: true, ignored: true });
    }

    console.log(
      `Ingest /v1/copilot-cli/hook: type=${notification.type} session=${notification.sessionId} ${summary}`
    );
    await this.notifier.send(notification);
    return json({ ok: true });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse a normalized /v1/notify JSON body into a Notification (exported for tests). */
export function parseNotifyBody(body: unknown): Notification {
  if (typeof body !== "object" || body === null) {
    throw new Error("Body must be a JSON object");
  }

  const obj = body as Record<string, unknown>;

  const type = obj.type;
  if (type !== "idle" && type !== "question" && type !== "permission") {
    throw new Error('type must be "idle", "question", or "permission"');
  }

  if (typeof obj.sessionId !== "string" || !obj.sessionId) {
    throw new Error("sessionId is required and must be a string");
  }

  const projectDirectory =
    typeof obj.projectDirectory === "string" ? obj.projectDirectory : "";
  const sessionTitle =
    typeof obj.sessionTitle === "string" && obj.sessionTitle
      ? obj.sessionTitle
      : obj.sessionId;
  const projectId = typeof obj.projectId === "string" ? obj.projectId : "";
  const desktopUrl = typeof obj.desktopUrl === "string" ? obj.desktopUrl : "";

  let source: Notification["source"];
  if (
    obj.source === "claude-code" ||
    obj.source === "opencode" ||
    obj.source === "grok-code" ||
    obj.source === "codex" ||
    obj.source === "copilot-cli"
  ) {
    source = obj.source;
  }

  // Prefer original event time when forwarded from a child instance.
  let timestamp = new Date();
  if (typeof obj.timestamp === "string" && obj.timestamp) {
    const parsed = new Date(obj.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      timestamp = parsed;
    }
  }

  const notification: Notification = {
    type: type as NotificationType,
    source,
    sessionId: obj.sessionId,
    sessionTitle,
    projectId,
    projectDirectory,
    desktopUrl,
    timestamp,
  };

  // Child host must win so parent providers show the origin machine.
  if (typeof obj.hostname === "string" && obj.hostname.trim()) {
    notification.hostname = obj.hostname.trim();
  }

  if (
    typeof obj.hops === "number" &&
    Number.isInteger(obj.hops) &&
    obj.hops >= 0
  ) {
    notification.hops = obj.hops;
  }

  if (typeof obj.question === "string") {
    notification.question = obj.question;
  }
  if (typeof obj.permissionTitle === "string") {
    notification.permissionTitle = obj.permissionTitle;
  }
  if (typeof obj.permissionType === "string") {
    notification.permissionType = obj.permissionType;
  }
  if (Array.isArray(obj.choices)) {
    notification.choices = parseChoices(obj.choices);
  }

  return notification;
}

function parseChoices(choices: unknown[]): NotificationChoice[] {
  const result: NotificationChoice[] = [];
  for (const item of choices) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.label !== "string" || !c.label) continue;
    result.push({
      label: c.label,
      description: typeof c.description === "string" ? c.description : undefined,
    });
  }
  return result;
}
