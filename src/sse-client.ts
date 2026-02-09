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

export interface SessionInfo {
  id: string;
  parentSessionID?: string;
  title: string;
  projectID: string;
}

type EventHandler = (event: SessionStatusEvent, directory: string) => void;
type QuestionToolHandler = (sessionID: string, toolState: ToolState, directory: string) => void;

export class SSEClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private abortController: AbortController | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private isRunning = false;
  private eventHandlers: EventHandler[] = [];
  private questionToolHandlers: QuestionToolHandler[] = [];

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

  onQuestionTool(handler: QuestionToolHandler): void {
    this.questionToolHandlers.push(handler);
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
      this.processEvent(this.currentEventData);
      this.currentEventData = "";
    }
  }

  private processEvent(data: string): void {
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
      } else if (payload.type === "message.part.updated") {
        const partEvent = payload as MessagePartUpdatedEvent;
        const part = partEvent.properties.part;

        // Check if this is a question tool call
        if (part.type === "tool" && (part as ToolPart).tool === "question") {
          const toolPart = part as ToolPart;
          for (const handler of this.questionToolHandlers) {
            handler(toolPart.sessionID, toolPart.state, directory);
          }
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
