import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  activeBackgroundTasks,
  describeBackgroundTasks,
  mapClaudeCodeHook,
  readClaudeCodeSessionTitle,
  transcriptTailBytes,
  type ClaudeCodeHookPayload,
} from "./claude-code.ts";

async function withTranscript(
  body: string,
  run: (transcriptPath: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oc-notifier-claude-"));
  try {
    const transcriptPath = join(dir, "abc123.jsonl");
    await writeFile(transcriptPath, body);
    await run(transcriptPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonl(...entries: Record<string, unknown>[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

const userLine = {
  type: "user",
  sessionId: "abc123",
  message: { role: "user", content: "Run a delayed background job" },
};
const aiTitle = (title: string) => ({ type: "ai-title", aiTitle: title, sessionId: "abc123" });
const customTitle = (title: string) => ({
  type: "custom-title",
  customTitle: title,
  sessionId: "abc123",
});

const readTitle = (path: string) => readClaudeCodeSessionTitle(path, "abc123");

/** One ASCII user line of exactly `bytes` bytes, newline included. */
function paddingLine(bytes: number): string {
  const empty = jsonl({ ...userLine, message: { role: "user", content: "" } });
  return jsonl({ ...userLine, message: { role: "user", content: "x".repeat(bytes - empty.length) } });
}

const stop: ClaudeCodeHookPayload = {
  session_id: "abc123",
  cwd: "/home/dev/oc-notifier",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Done.",
};

describe("mapClaudeCodeHook Stop", () => {
  test("notifies idle when background_tasks is absent (older Claude Code)", async () => {
    const notification = await mapClaudeCodeHook(stop);

    expect(notification?.type).toBe("idle");
    expect(notification?.source).toBe("claude-code");
    expect(notification?.sessionId).toBe("abc123");
    expect(notification?.sessionTitle).toBe("oc-notifier");
  });

  test("notifies idle when nothing is in flight", async () => {
    const notification = await mapClaudeCodeHook({ ...stop, background_tasks: [], session_crons: [] });

    expect(notification?.type).toBe("idle");
  });

  test("waits while a background subagent is running", async () => {
    const notification = await mapClaudeCodeHook({
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

  test("waits while a background shell is running", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "task-002", type: "shell", status: "running", command: "bun test --watch" },
      ],
    });

    expect(notification).toBeNull();
  });

  test("waits on tasks with a pending or unknown status", async () => {
    expect(
      await mapClaudeCodeHook({
        ...stop,
        background_tasks: [{ id: "task-003", type: "workflow", status: "pending" }],
      })
    ).toBeNull();

    expect(
      await mapClaudeCodeHook({
        ...stop,
        background_tasks: [{ id: "task-004", type: "monitor" }],
      })
    ).toBeNull();
  });

  test("notifies once the last task has finished", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "task-001", type: "subagent", status: "completed" },
        { id: "task-002", type: "shell", status: "failed" },
        { id: "task-003", type: "shell", status: "killed" },
      ],
    });

    expect(notification?.type).toBe("idle");
  });

  test("scheduled crons alone do not hold back the notification", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      background_tasks: [],
      session_crons: [
        { id: "cron-001", schedule: "0 9 * * 1-5", recurring: true, prompt: "check the build" },
      ],
    });

    expect(notification?.type).toBe("idle");
  });

  test("agent-team teammates do not hold back the notification", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "tm-1", type: "teammate", status: "running", description: "researcher" },
      ],
    });

    expect(notification?.type).toBe("idle");
  });

  test("a teammate alongside a running subagent still waits", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      background_tasks: [
        { id: "tm-1", type: "teammate", status: "running" },
        { id: "task-001", type: "subagent", status: "running" },
      ],
    });

    expect(notification).toBeNull();
  });

  test("events carrying agent_id stay ignored even with nothing in flight", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      agent_id: "def456",
      agent_type: "Explore",
      background_tasks: [],
    });

    expect(notification).toBeNull();
  });
});

describe("mapClaudeCodeHook StopFailure", () => {
  test("notifies idle with the API error in the title", async () => {
    const notification = await mapClaudeCodeHook({
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

  test("falls back to unknown when error is missing", async () => {
    const notification = await mapClaudeCodeHook({ ...stop, hook_event_name: "StopFailure" });

    expect(notification?.sessionTitle).toBe("API error: unknown");
  });
});

describe("mapClaudeCodeHook session title", () => {
  test("uses the ai-title from the transcript", async () => {
    await withTranscript(jsonl(userLine, aiTitle("Delayed background job test")), async (path) => {
      const notification = await mapClaudeCodeHook({ ...stop, transcript_path: path });

      expect(notification?.type).toBe("idle");
      expect(notification?.sessionTitle).toBe("Delayed background job test");
    });
  });

  test("a /rename custom-title wins over a later ai-title", async () => {
    await withTranscript(
      jsonl(userLine, aiTitle("Auto title"), customTitle("My rename"), aiTitle("Auto title")),
      async (path) => {
        const notification = await mapClaudeCodeHook({ ...stop, transcript_path: path });

        expect(notification?.sessionTitle).toBe("My rename");
      }
    );
  });

  test("the latest record of a type wins", async () => {
    await withTranscript(
      jsonl(customTitle("First name"), userLine, customTitle("Second name")),
      async (path) => {
        expect(await readTitle(path)).toBe("Second name");
      }
    );
  });

  test("a cleared custom-title falls back to the ai-title", async () => {
    for (const cleared of ["", "   "]) {
      await withTranscript(
        jsonl(customTitle("Old name"), aiTitle("Auto title"), customTitle(cleared)),
        async (path) => {
          expect(await readTitle(path)).toBe("Auto title");
        }
      );
    }
  });

  test("uses a legacy summary record when there is no title", async () => {
    await withTranscript(
      jsonl({ type: "summary", summary: "Fix flaky tests", leafUuid: "u-1" }, userLine),
      async (path) => {
        expect(await readTitle(path)).toBe("Fix flaky tests");
      }
    );
  });

  test("ignores title records from another session", async () => {
    await withTranscript(
      jsonl(aiTitle("Mine"), { ...aiTitle("Theirs"), sessionId: "other" }),
      async (path) => {
        expect(await readTitle(path)).toBe("Mine");
      }
    );
  });

  test("ignores title-like text inside messages", async () => {
    const spoof = JSON.stringify(aiTitle("Spoofed"));
    await withTranscript(
      jsonl({ ...userLine, message: { role: "user", content: spoof } }),
      async (path) => {
        expect(await readTitle(path)).toBeUndefined();
      }
    );
  });

  test("finds the re-appended title at the end of a large transcript", async () => {
    const body =
      jsonl(aiTitle("Stale title")) +
      paddingLine(2 * transcriptTailBytes) +
      jsonl(aiTitle("Current title"));

    await withTranscript(body, async (path) => {
      expect(await readTitle(path)).toBe("Current title");
    });
  });

  test("reads only the transcript tail", async () => {
    const body = jsonl(aiTitle("Too early")) + paddingLine(transcriptTailBytes + 1);

    await withTranscript(body, async (path) => {
      expect(await readTitle(path)).toBeUndefined();
    });
  });

  test("keeps a title line that starts exactly at the window edge", async () => {
    const title = jsonl(aiTitle("Edge title"));
    const body = jsonl(userLine) + title + paddingLine(transcriptTailBytes - title.length);

    await withTranscript(body, async (path) => {
      expect(await readTitle(path)).toBe("Edge title");
    });
  });

  test("drops a first line cut inside a multi-byte character", async () => {
    const cut = jsonl({ ...userLine, message: { role: "user", content: "🙂🙂" } });
    const title = jsonl(aiTitle("After the cut"));
    // The window opens on the 2nd byte of the last emoji: 3 emoji bytes + `"}}\n` remain.
    const body = cut + title + paddingLine(transcriptTailBytes + 1 - 7 - title.length);

    await withTranscript(body, async (path) => {
      expect(await readTitle(path)).toBe("After the cut");
    });
  });

  test("permission prompts carry the session title too", async () => {
    await withTranscript(jsonl(aiTitle("Clean build")), async (path) => {
      const notification = await mapClaudeCodeHook({
        session_id: "abc123",
        cwd: "/home/dev/oc-notifier",
        transcript_path: path,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/build" },
      });

      expect(notification?.type).toBe("permission");
      expect(notification?.sessionTitle).toBe("Clean build");
    });
  });

  test("StopFailure keeps the API error as its title", async () => {
    await withTranscript(jsonl(aiTitle("Clean build")), async (path) => {
      const notification = await mapClaudeCodeHook({
        ...stop,
        transcript_path: path,
        hook_event_name: "StopFailure",
        error: "rate_limit",
      });

      expect(notification?.sessionTitle).toBe("API error: rate_limit");
    });
  });

  test("falls back to the project name when the transcript has no title", async () => {
    await withTranscript(jsonl(userLine), async (path) => {
      const notification = await mapClaudeCodeHook({ ...stop, transcript_path: path });

      expect(notification?.sessionTitle).toBe("oc-notifier");
    });
  });

  test("falls back to the project name when the transcript is missing", async () => {
    const notification = await mapClaudeCodeHook({
      ...stop,
      transcript_path: join(tmpdir(), "oc-notifier-missing", "abc123.jsonl"),
    });

    expect(notification?.sessionTitle).toBe("oc-notifier");
  });

  test("a malformed transcript_path does not drop the notification", async () => {
    for (const transcript_path of [123, {}, ["/tmp/abc123.jsonl"], true]) {
      const payload = { ...stop, transcript_path } as unknown as ClaudeCodeHookPayload;
      const notification = await mapClaudeCodeHook(payload);

      expect(notification?.type).toBe("idle");
      expect(notification?.sessionTitle).toBe("oc-notifier");
    }
  });

  test("only reads the session's own absolute transcript file", async () => {
    const body = jsonl(aiTitle("Clean build"));
    await withTranscript(body, async (path) => {
      const otherSession = join(dirname(path), "other.jsonl");
      const notTranscript = path.replace(/\.jsonl$/, ".json");
      await writeFile(otherSession, body);
      await writeFile(notTranscript, body);

      expect(await readTitle(path)).toBe("Clean build");
      expect(await readTitle(otherSession)).toBeUndefined();
      expect(await readTitle(notTranscript)).toBeUndefined();
      expect(await readTitle("abc123.jsonl")).toBeUndefined();
      // `//host/share/…` is a UNC path on Windows; the same file on POSIX.
      expect(await readTitle(`/${path}`)).toBeUndefined();
      expect(await readClaudeCodeSessionTitle(path, undefined)).toBeUndefined();
      expect(await readClaudeCodeSessionTitle(undefined, "abc123")).toBeUndefined();
    });
  });

  // Reading a FIFO with no writer blocks forever.
  test.skipIf(process.platform === "win32")(
    "ignores a named pipe named like the transcript",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "oc-notifier-claude-"));
      try {
        const path = join(dir, "abc123.jsonl");
        expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);

        expect(await readTitle(path)).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    2000
  );
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

  test("ignores a non-array background_tasks value", async () => {
    const payload = { ...stop, background_tasks: "nope" } as unknown as ClaudeCodeHookPayload;

    expect(activeBackgroundTasks(payload)).toEqual([]);
    expect((await mapClaudeCodeHook(payload))?.type).toBe("idle");
  });
});
