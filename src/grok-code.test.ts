import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { mapGrokCodeHook } from "./grok-code.ts";

async function withGrokHome(
  setup: (grokHome: string) => Promise<void>,
  run: (grokHome: string) => Promise<void>
): Promise<void> {
  const grokHome = await mkdtemp(join(tmpdir(), "oc-notifier-grok-"));
  try {
    await setup(grokHome);
    await run(grokHome);
  } finally {
    await rm(grokHome, { recursive: true, force: true });
  }
}

async function writeSummary(
  grokHome: string,
  cwd: string,
  sessionId: string,
  body: Record<string, unknown>
): Promise<void> {
  const dir = join(grokHome, "sessions", encodeURIComponent(cwd), sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify(body));
}

describe("mapGrokCodeHook session title", () => {
  test("uses generated_title from Grok summary.json", async () => {
    const cwd = "/home/ben/source/repos/oc-notifier";
    const sessionId = "01a05b60-7a51-79f3-8410-d9d5f0f002c1";

    await withGrokHome(
      (grokHome) =>
        writeSummary(grokHome, cwd, sessionId, {
          generated_title: "Rayleigh Scattering Explains Blue Sky Color",
          session_summary: "Sky is blue from Rayleigh scattering",
        }),
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId,
            cwd,
            hookEventName: "stop",
            reason: "end_turn",
          },
          { grokHome }
        );

        expect(notification?.type).toBe("idle");
        expect(notification?.sessionTitle).toBe(
          "Rayleigh Scattering Explains Blue Sky Color"
        );
      }
    );
  });

  test("falls back to session_summary when generated_title is missing", async () => {
    const cwd = "/tmp/demo";
    const sessionId = "ses_summary_only";

    await withGrokHome(
      (grokHome) =>
        writeSummary(grokHome, cwd, sessionId, {
          session_summary: "Wire Grok session titles into Discord",
        }),
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId,
            cwd,
            hookEventName: "stop",
            reason: "end_turn",
          },
          { grokHome }
        );

        expect(notification?.sessionTitle).toBe(
          "Wire Grok session titles into Discord"
        );
      }
    );
  });

  test("keeps the project folder name when no summary exists", async () => {
    await withGrokHome(
      async () => undefined,
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId: "missing-session",
            cwd: "/home/ben/source/repos/oc-notifier",
            hookEventName: "stop",
            reason: "end_turn",
          },
          { grokHome }
        );

        expect(notification?.sessionTitle).toBe("oc-notifier");
      }
    );
  });

  test("finds a session under a hashed cwd group by id", async () => {
    const sessionId = "hashed-session-id";
    const title = "Long path session title";

    await withGrokHome(
      async (grokHome) => {
        const dir = join(grokHome, "sessions", "slug_deadbeef", sessionId);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "summary.json"),
          JSON.stringify({ generated_title: title })
        );
      },
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId,
            cwd: "/a/very/long/path/that/is/not/the-encoded-dir-name",
            hookEventName: "stop",
            reason: "end_turn",
          },
          { grokHome }
        );

        expect(notification?.sessionTitle).toBe(title);
      }
    );
  });

  test("applies the stored title to permission notifications", async () => {
    const cwd = "/home/ben/app";
    const sessionId = "perm-session";

    await withGrokHome(
      (grokHome) =>
        writeSummary(grokHome, cwd, sessionId, {
          generated_title: "Approve a bash command",
        }),
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId,
            cwd,
            hookEventName: "notification",
            notificationType: "permission_prompt",
            message: "Allow bash?",
          },
          { grokHome }
        );

        expect(notification?.type).toBe("permission");
        expect(notification?.sessionTitle).toBe("Approve a bash command");
      }
    );
  });

  test("ignores path-like session ids instead of reading outside grok home", async () => {
    await withGrokHome(
      async () => undefined,
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId: "../etc",
            cwd: "/home/ben/source/repos/oc-notifier",
            hookEventName: "stop",
            reason: "end_turn",
          },
          { grokHome }
        );

        expect(notification?.sessionTitle).toBe("oc-notifier");
      }
    );
  });

  test("does not look up a title for ignored session-end Stop fires", async () => {
    const cwd = "/home/ben/source/repos/oc-notifier";
    const sessionId = "shutdown-session";

    await withGrokHome(
      (grokHome) =>
        writeSummary(grokHome, cwd, sessionId, {
          generated_title: "Should not appear",
        }),
      async (grokHome) => {
        const notification = await mapGrokCodeHook(
          {
            sessionId,
            cwd,
            hookEventName: "stop",
            reason: "channel_closed",
          },
          { grokHome }
        );

        expect(notification).toBeNull();
      }
    );
  });
});
