/**
 * SSE Client for OpenCode server
 * Connects to /global/event endpoint to receive events from all projects
 * Handles reconnection with exponential backoff
 */

import type { OpenCodeConfig } from "./config.ts";

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface SessionStatusEvent {
  type: "session.status";
  properties: {
    sessionID: string;
    status: SessionStatus;
  };
}

// Tool state types for tracking tool execution
export type ToolState =
  | { status: "pending"; input: Record<string, unknown> }
  | { status: "running"; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; output: string; title: string; metadata: Record<string, unknown> }
  | { status: "error"; input: Record<string, unknown>; error: string };

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
}

export interface MessagePartUpdatedEvent {
  type: "message.part.updated";
  properties: {
    part: ToolPart | { type: string; sessionID?: string };
    delta?: string;
  };
}

// Global event wrapper - events from /global/event are wrapped with directory info
export interface GlobalEvent {
  directory: string;
  payload: { type: string; properties?: unknown };
}

// Permission event types (v2)
export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface PermissionAskedEvent {
  type: "permission.asked";
  properties: PermissionRequest;
}

// Permission event types (legacy)
export interface PermissionLegacy {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export interface PermissionUpdatedEvent {
  type: "permission.updated";
  properties: PermissionLegacy;
}

/** Normalized permission event consumed by handlers */
export interface PermissionEvent {
  id: string;
  sessionID: string;
  title: string;
  permissionType: string;
  patterns: string[];
  alwaysPatterns: string[];
  metadata: Record<string, unknown>;
  /** Tool call this request belongs to; correlates v2 and legacy events */
  callID?: string;
}

// Question event types (v2)
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface QuestionAskedEvent {
  type: "question.asked";
  properties: QuestionRequest;
}

/** Normalized question event consumed by handlers */
export interface QuestionEvent {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  /** Tool call this question belongs to; correlates v2 and legacy events */
  callID?: string;
}

export interface SessionInfo {
  id: string;
  parentSessionID?: string;
  title: string;
  projectID: string;
  directory?: string;
}

type EventHandler = (event: SessionStatusEvent, directory: string) => void;
type QuestionHandler = (question: QuestionEvent, directory: string) => void;
type PermissionHandler = (permission: PermissionEvent, directory: string) => void;

export class SSEClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private abortController: AbortController | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private isRunning = false;
  private eventHandlers: EventHandler[] = [];
  private questionHandlers: QuestionHandler[] = [];
  private permissionHandlers: PermissionHandler[] = [];
  // A server that speaks the v2 events also emits a tool part / legacy event for
  // the same request. Once we have proof of v2, the older path is pure duplicate.
  private sawQuestionAsked = false;
  private sawPermissionAsked = false;

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

  async fetchSessionInfo(sessionId: string, directory: string): Promise<SessionInfo | null> {
    try {
      const url = `${this.baseUrl}/session/${sessionId}?directory=${encodeURIComponent(directory)}`;
      console.log(`[DEBUG] fetchSessionInfo requesting: ${url}`);
      const response = await fetch(url, {
        headers: this.headers,
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`Failed to fetch session info: ${response.status} ${text}`);
        return null;
      }

      const data = await response.json() as { id: string; parentID?: string; title?: string; projectID: string };
      console.log(`[DEBUG] fetchSessionInfo response for ${sessionId}: ${JSON.stringify(data)}`);
      const info: SessionInfo = {
        id: data.id,
        parentSessionID: data.parentID,
        title: data.title || sessionId,
        projectID: data.projectID,
      };

      return info;
    } catch (error) {
      console.error(`Error fetching session info:`, error);
      return null;
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

        console.error(`SSE connection error:`, error);
        console.log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);

        await this.sleep(this.reconnectDelay);

        // Exponential backoff
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

    const url = `${this.baseUrl}/global/event`;
    console.log(`Connecting to ${url} (global events from all projects)...`);

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

    console.log("Connected to SSE stream");
    this.reconnectDelay = 1000; // Reset backoff on successful connection

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.isRunning) {
        const { done, value } = await reader.read();

        if (done) {
          console.log("SSE stream ended");
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Keep the last incomplete line in the buffer
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
    if (line.startsWith("data:")) {
      this.currentEventData += line.slice(5).trim();
    } else if (line === "" && this.currentEventData) {
      // Empty line means end of event
      this.handleEventData(this.currentEventData);
      this.currentEventData = "";
    }
  }

  /** Route one SSE `data:` payload to handlers. Public for tests. */
  handleEventData(data: string): void {
    try {
      // Global events are wrapped in { directory, payload } format
      const globalEvent = JSON.parse(data) as GlobalEvent;
      const { directory, payload } = globalEvent;

      if (payload.type === "session.status") {
        const statusEvent = payload as SessionStatusEvent;
        if (statusEvent.properties.status.type === "idle") {
          console.log(`[DEBUG] Raw idle SSE event JSON: ${data}`);
        }
        for (const handler of this.eventHandlers) {
          handler(statusEvent, directory);
        }
      } else if (payload.type === "question.asked") {
        const questionEvent = payload as QuestionAskedEvent;
        this.sawQuestionAsked = true;
        const normalized = normalizeQuestionRequest(questionEvent.properties);
        for (const handler of this.questionHandlers) {
          handler(normalized, directory);
        }
      } else if (payload.type === "message.part.updated") {
        const partEvent = payload as MessagePartUpdatedEvent;
        const part = partEvent.properties.part;

        // Legacy fallback: question tool via message.part.updated. Servers that
        // emit question.asked also emit this part for the same ask, so the
        // fallback is only for servers that never send the v2 event.
        //
        // The part usually lands *before* question.asked (the tool goes running,
        // then execute() publishes), so the latch rarely suppresses the twin —
        // the call-id correlation in opencode-monitor.ts does that. What the
        // latch does catch is a part with no ask behind it: when the question
        // permission is denied (subagents deny it by default) the tool still
        // goes running but nothing is ever asked.
        if (
          !this.sawQuestionAsked &&
          part.type === "tool" &&
          (part as ToolPart).tool === "question"
        ) {
          const toolPart = part as ToolPart;
          const normalized = normalizeQuestionFromTool(toolPart);
          if (normalized) {
            for (const handler of this.questionHandlers) {
              handler(normalized, directory);
            }
          }
        }
      } else if (payload.type === "permission.asked") {
        const permEvent = payload as PermissionAskedEvent;
        this.sawPermissionAsked = true;
        const normalized = normalizePermissionRequest(permEvent.properties);
        for (const handler of this.permissionHandlers) {
          handler(normalized, directory);
        }
      } else if (payload.type === "permission.updated") {
        // Legacy twin of permission.asked; skip once the server proved it is v2.
        if (this.sawPermissionAsked) {
          return;
        }
        const permEvent = payload as PermissionUpdatedEvent;
        const normalized = normalizeLegacyPermission(permEvent.properties);
        for (const handler of this.permissionHandlers) {
          handler(normalized, directory);
        }
      }
    } catch (error) {
      console.error(`Failed to parse SSE event:`, error, data);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function normalizePermissionRequest(request: PermissionRequest): PermissionEvent {
  const patterns = request.patterns;
  const title = patterns.length > 0
    ? `${request.permission}: ${patterns.join(", ")}`
    : request.permission;

  return {
    id: request.id,
    sessionID: request.sessionID,
    title,
    permissionType: request.permission,
    patterns,
    alwaysPatterns: request.always,
    metadata: request.metadata,
    callID: request.tool?.callID,
  };
}

function normalizeLegacyPermission(permission: PermissionLegacy): PermissionEvent {
  const patterns = Array.isArray(permission.pattern)
    ? permission.pattern
    : permission.pattern
      ? [permission.pattern]
      : [];

  return {
    id: permission.id,
    sessionID: permission.sessionID,
    title: permission.title,
    permissionType: permission.type,
    patterns,
    alwaysPatterns: patterns,
    metadata: permission.metadata,
    callID: permission.callID,
  };
}

function normalizeQuestionRequest(request: QuestionRequest): QuestionEvent {
  return {
    id: request.id,
    sessionID: request.sessionID,
    questions: request.questions,
    callID: request.tool?.callID,
  };
}

function normalizeQuestionFromTool(part: ToolPart): QuestionEvent | null {
  const toolState = part.state;
  if (toolState.status !== "running") {
    return null;
  }

  const input = toolState.input as {
    questions?: Array<{
      question?: string;
      header?: string;
      options?: Array<{ label?: string; description?: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
  };

  const questions: QuestionInfo[] = input.questions?.map((item) => ({
    question: item.question || "OpenCode is waiting for your input",
    header: item.header,
    options: (item.options ?? []).map((option) => ({
      label: option.label || "Option",
      description: option.description,
    })),
    multiple: item.multiple,
    custom: item.custom,
  })) ?? [{
    question: "OpenCode is waiting for your input",
    options: [],
  }];

  const firstQuestion = questions[0]?.question ?? "OpenCode is waiting for your input";

  return {
    id: part.callID
      ? `${part.sessionID}:${part.callID}`
      : `${part.sessionID}:${firstQuestion.slice(0, 100)}`,
    sessionID: part.sessionID,
    questions,
    callID: part.callID,
  };
}
