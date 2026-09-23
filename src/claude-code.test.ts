import { describe, expect, test } from "bun:test";
import {
  activeBackgroundTasks,
  describeBackgroundTasks,
  mapClaudeCodeHook,
  type ClaudeCodeHookPayload,
} from "./claude-code.ts";

const stop: ClaudeCodeHookPayload = {
  session_id: "abc123",
  cwd: "/home/dev/oc-notifier",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Done.",
};

describe("mapClaudeCodeHook Stop", () => {
  test("notifies idle when background_tasks is absent (older Claude Code)", () => {
    const notification = mapClaudeCodeHook(stop);

    expect(notification?.type).toBe("idle");
    expect(notification?.source).toBe("claude-code");
    expect(notification?.sessionId).toBe("abc123");
    expect(notification?.sessionTitle).toBe("oc-notifier");
  });

  test("notifies idle when nothing is in flight", () => {
    const notification = mapClaudeCodeHook({ ...stop, background_tasks: [], session_crons: [] });

    expect(notification?.type).toBe("idle");
  });

  test("waits while a background subagent is running", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        {
          id: "task-001",
          type: "subagent",
          status: "running",
          description: "Review the PR",
          agent_type: "general-purpose",
        },
      ],
    });

    expect(notification).toBeNull();
  });

  test("waits while a background shell is running", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "task-002", type: "shell", status: "running", command: "bun test --watch" },
      ],
    });

    expect(notification).toBeNull();
  });

  test("waits on tasks with a pending or unknown status", () => {
    expect(
      mapClaudeCodeHook({
        ...stop,
        background_tasks: [{ id: "task-003", type: "workflow", status: "pending" }],
      })
    ).toBeNull();

    expect(
      mapClaudeCodeHook({
        ...stop,
        background_tasks: [{ id: "task-004", type: "monitor" }],
      })
    ).toBeNull();
  });

  test("notifies once the last task has finished", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "task-001", type: "subagent", status: "completed" },
        { id: "task-002", type: "shell", status: "failed" },
        { id: "task-003", type: "shell", status: "killed" },
      ],
    });

    expect(notification?.type).toBe("idle");
  });

  test("scheduled crons alone do not hold back the notification", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      background_tasks: [],
      session_crons: [
        { id: "cron-001", schedule: "0 9 * * 1-5", recurring: true, prompt: "check the build" },
      ],
    });

    expect(notification?.type).toBe("idle");
  });

  test("agent-team teammates do not hold back the notification", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "tm-1", type: "teammate", status: "running", description: "researcher" },
      ],
    });

    expect(notification?.type).toBe("idle");
  });

  test("a teammate alongside a running subagent still waits", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "tm-1", type: "teammate", status: "running" },
        { id: "task-001", type: "subagent", status: "running" },
      ],
    });

    expect(notification).toBeNull();
  });

  test("events carrying agent_id stay ignored even with nothing in flight", () => {
    const notification = mapClaudeCodeHook({
      ...stop,
      agent_id: "def456",
      agent_type: "Explore",
      background_tasks: [],
    });

    expect(notification).toBeNull();
  });
});

describe("mapClaudeCodeHook StopFailure", () => {
  test("notifies idle with the API error in the title", () => {
    const notification = mapClaudeCodeHook({
      session_id: "abc123",
      cwd: "/home/dev/oc-notifier",
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429 Too Many Requests",
      last_assistant_message: "API Error: Rate limit reached",
    });

    expect(notification?.type).toBe("idle");
    expect(notification?.sessionId).toBe("abc123");
    expect(notification?.sessionTitle).toBe("API error: rate_limit");
  });

  test("falls back to unknown when error is missing", () => {
    const notification = mapClaudeCodeHook({ ...stop, hook_event_name: "StopFailure" });

    expect(notification?.sessionTitle).toBe("API error: unknown");
  });
});

describe("activeBackgroundTasks", () => {
  test("keeps malformed entries as active and drops finished ones", () => {
    const payload: ClaudeCodeHookPayload = {
      ...stop,
      background_tasks: [
        null,
        "task-xyz",
        { id: "a", type: "shell", status: "RUNNING" },
        { id: "b", type: "subagent", status: "Completed" },
        { id: "c", type: 42, status: null },
      ],
    };

    const active = activeBackgroundTasks(payload);

    expect(active).toHaveLength(4);
    expect(describeBackgroundTasks(active)).toBe("task,task,shell,task");
  });

  test("log labels stay space-free", () => {
    const payload: ClaudeCodeHookPayload = {
      ...stop,
      background_tasks: [
        { type: "cloud session", status: "running" },
        { type: "MCP task", status: "running" },
      ],
    };

    expect(describeBackgroundTasks(activeBackgroundTasks(payload))).toBe("cloud_session,MCP_task");
  });

  test("ignores a non-array background_tasks value", () => {
    const payload = { ...stop, background_tasks: "nope" } as unknown as ClaudeCodeHookPayload;

    expect(activeBackgroundTasks(payload)).toEqual([]);
    expect(mapClaudeCodeHook(payload)?.type).toBe("idle");
  });
});
