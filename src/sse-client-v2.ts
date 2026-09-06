/**
 * SSE Client for OpenCode 2 server
 * Connects to /api/event to receive live events from all locations
 * Handles reconnection with exponential backoff
 */

import type { OpenCodeConfig } from "./config.ts";
import type {
  PermissionEvent,
  QuestionEvent,
  QuestionInfo,
  SessionInfo,
  SessionStatusEvent,
} from "./sse-client.ts";

export interface V2Event {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
  location?: {
    directory?: string;
    workspaceID?: string;
  };
}

type EventHandler = (event: SessionStatusEvent, directory: string) => void;
type QuestionHandler = (question: QuestionEvent, directory: string) => void;
type PermissionHandler = (permission: PermissionEvent, directory: string) => void;

const busyEventTypes = new Set([
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.step.started",
  "session.next.retried",
  "session.next.compaction.started",
]);

const idleEventTypes = new Set([
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.compaction.ended",
]);

/** Classify a V2 event type as session busy, idle-candidate, or neither. */
export function classifyV2SessionEvent(type: string): "busy" | "idle" | null {
  if (busyEventTypes.has(type)) return "busy";
  if (idleEventTypes.has(type)) return "idle";
  return null;
}

/** Parse a raw SSE data payload into a V2 event object. */
export function parseV2EventData(raw: string): V2Event | null {
  let parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string" || !obj.type) {
    return null;
  }
  const data = obj.data;
  const location = obj.location;
  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    type: obj.type,
    data: typeof data === "object" && data !== null ? data as Record<string, unknown> : undefined,
    location: typeof location === "object" && location !== null
      ? location as V2Event["location"]
      : undefined,
  };
}

export class SSEClientV2 {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private abortController: AbortController | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private isRunning = false;
  private eventHandlers: EventHandler[] = [];
  private questionHandlers: QuestionHandler[] = [];
  private permissionHandlers: PermissionHandler[] = [];

  constructor(config: OpenCodeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.headers = {};

    if (config.username && config.password) {
      const credentials = Buffer.from(`${config.username}:${config.password}`).toString("base64");
      this.headers["Authorization"] = `Basic ${credentials}`;
    }
  }

  onSessionStatus(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  onQuestion(handler: QuestionHandler): void {
    this.questionHandlers.push(handler);
  }

  onPermission(handler: PermissionHandler): void {
    this.permissionHandlers.push(handler);
  }

  async fetchSessionInfo(sessionId: string, _directory: string): Promise<SessionInfo | null> {
    try {
      const url = `${this.baseUrl}/api/session/${sessionId}`;
      console.log(`[DEBUG] fetchSessionInfo (v2) requesting: ${url}`);
      const response = await fetch(url, {
        headers: this.headers,
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`Failed to fetch session info: ${response.status} ${text}`);
        return null;
      }

      const body = await response.json() as {
        data?: {
          id: string;
          parentID?: string;
          title?: string;
          projectID: string;
          location?: { directory?: string };
        };
      };
      const data = body.data;
      if (!data) {
        console.error(`Session info response missing data for ${sessionId}`);
        return null;
      }

      console.log(`[DEBUG] fetchSessionInfo (v2) response for ${sessionId}: ${JSON.stringify(data)}`);
      return {
        id: data.id,
        parentSessionID: data.parentID,
        title: data.title || sessionId,
        projectID: data.projectID,
        directory: data.location?.directory,
      };
    } catch (error) {
      console.error(`Error fetching session info:`, error);
      return null;
    }
  }

  /**
   * True when the session is not in the server's active (running) set.
   * Used after debounce to avoid notifying mid-turn between steps.
   */
  async confirmIdle(sessionID: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/session/active`;
      const response = await fetch(url, {
        headers: this.headers,
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`Failed to fetch active sessions: ${response.status} ${text}`);
        return true;
      }

      const body = await response.json() as { data?: Record<string, unknown> };
      const active = body.data ?? {};
      return !(sessionID in active);
    } catch (error) {
      console.error(`Error fetching active sessions:`, error);
      return true;
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.reconnectDelay = 1000;

    while (this.isRunning) {
      try {
        await this.connect();
      } catch (error) {
        if (!this.isRunning) break;

        console.error(`OpenCode 2 SSE connection error:`, error);
        console.log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);

        await this.sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    this.abortController?.abort();
  }

  private async connect(): Promise<void> {
    this.abortController = new AbortController();

    const url = `${this.baseUrl}/api/event`;
    console.log(`Connecting to ${url} (OpenCode 2 events from all locations)...`);

    const response = await fetch(url, {
      headers: {
        ...this.headers,
        Accept: "text/event-stream",
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    console.log("Connected to OpenCode 2 SSE stream");
    this.reconnectDelay = 1000;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.isRunning) {
        const { done, value } = await reader.read();

        if (done) {
          console.log("OpenCode 2 SSE stream ended");
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          this.processLine(line);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private currentEventData = "";

  private processLine(line: string): void {
    if (line.startsWith(":")) {
      return;
    }

    if (line.startsWith("data:")) {
      this.currentEventData += line.slice(5).trim();
    } else if (line === "" && this.currentEventData) {
      this.processEvent(this.currentEventData);
      this.currentEventData = "";
    }
  }

  private processEvent(raw: string): void {
    try {
      const event = parseV2EventData(raw);
      if (!event) {
        return;
      }

      const directory = event.location?.directory ?? "";
      const data = event.data ?? {};

      if (event.type === "session.status") {
        const sessionID = data.sessionID;
        const status = data.status;
        if (typeof sessionID !== "string" || typeof status !== "object" || status === null) {
          return;
        }
        const statusType = (status as { type?: unknown }).type;
        if (statusType !== "idle" && statusType !== "busy" && statusType !== "retry") {
          return;
        }
        this.emitSessionStatus(sessionID, status as SessionStatusEvent["properties"]["status"], directory);
        return;
      }

      const classified = classifyV2SessionEvent(event.type);
      if (classified) {
        const sessionID = data.sessionID;
        if (typeof sessionID !== "string" || !sessionID) {
          return;
        }
        this.emitSessionStatus(sessionID, { type: classified }, directory);
        return;
      }

      if (event.type === "question.v2.asked") {
        const normalized = normalizeQuestionRequest(data);
        if (!normalized) return;
        for (const handler of this.questionHandlers) {
          handler(normalized, directory);
        }
        return;
      }

      if (event.type === "permission.v2.asked") {
        const normalized = normalizePermissionRequest(data);
        if (!normalized) return;
        for (const handler of this.permissionHandlers) {
          handler(normalized, directory);
        }
      }
    } catch (error) {
      console.error(`Failed to parse OpenCode 2 SSE event:`, error, raw);
    }
  }

  private emitSessionStatus(
    sessionID: string,
    status: SessionStatusEvent["properties"]["status"],
    directory: string,
  ): void {
    const statusEvent: SessionStatusEvent = {
      type: "session.status",
      properties: { sessionID, status },
    };
    if (status.type === "idle") {
      console.log(`[DEBUG] OpenCode 2 idle event for ${sessionID} (project: ${directory || "(unknown)"})`);
    }
    for (const handler of this.eventHandlers) {
      handler(statusEvent, directory);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Tool call behind a request, used to collapse duplicate events for one ask */
function toolCallID(data: Record<string, unknown>): string | undefined {
  const tool = data.tool;
  if (typeof tool !== "object" || tool === null) return undefined;
  const callID = (tool as { callID?: unknown }).callID;
  return typeof callID === "string" ? callID : undefined;
}

function normalizePermissionRequest(data: Record<string, unknown>): PermissionEvent | null {
  if (typeof data.id !== "string" || typeof data.sessionID !== "string") {
    return null;
  }

  const action = typeof data.action === "string" ? data.action : "permission";
  const resources = asStringArray(data.resources);
  const save = asStringArray(data.save);
  const title = resources.length > 0 ? `${action}: ${resources.join(", ")}` : action;
  const metadata = typeof data.metadata === "object" && data.metadata !== null
    ? data.metadata as Record<string, unknown>
    : {};

  return {
    id: data.id,
    sessionID: data.sessionID,
    title,
    permissionType: action,
    patterns: resources,
    alwaysPatterns: save.length > 0 ? save : resources,
    metadata,
    callID: toolCallID(data),
  };
}

function normalizeQuestionRequest(data: Record<string, unknown>): QuestionEvent | null {
  if (typeof data.id !== "string" || typeof data.sessionID !== "string") {
    return null;
  }

  const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
  const questions: QuestionInfo[] = rawQuestions.map((item) => {
    const q = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const options = Array.isArray(q.options) ? q.options : [];
    return {
      question: typeof q.question === "string" ? q.question : "OpenCode is waiting for your input",
      header: typeof q.header === "string" ? q.header : undefined,
      options: options.map((option) => {
        const o = (typeof option === "object" && option !== null ? option : {}) as Record<string, unknown>;
        return {
          label: typeof o.label === "string" ? o.label : "Option",
          description: typeof o.description === "string" ? o.description : undefined,
        };
      }),
      multiple: typeof q.multiple === "boolean" ? q.multiple : undefined,
      custom: typeof q.custom === "boolean" ? q.custom : undefined,
    };
  });

  return {
    id: data.id,
    sessionID: data.sessionID,
    questions: questions.length > 0 ? questions : [{
      question: "OpenCode is waiting for your input",
      options: [],
    }],
    callID: toolCallID(data),
  };
}
