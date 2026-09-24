import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MSTeamsProvider } from "./msteams.ts";
import type { Notification, NotificationType } from "./types.ts";

function makeNotification(type: NotificationType): Notification {
  return {
    type,
    source: "opencode",
    sessionId: "ses_123",
    sessionTitle: "Fix bug",
    projectId: "proj_1",
    projectDirectory: "/home/dev/work/my-app",
    desktopUrl: "",
    hostname: "devbox",
    timestamp: new Date("2026-08-04T12:00:00.000Z"),
  };
}

describe("MSTeamsProvider", () => {
  const originalFetch = globalThis.fetch;
  let bodies: unknown[];

  beforeEach(() => {
    bodies = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("1", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function sentTitle(): string {
    const card = bodies[0] as {
      attachments: Array<{ content: { body: Array<{ text?: string }> } }>;
    };
    return card.attachments[0]?.content.body[0]?.text ?? "";
  }

  test.each([
    ["idle", "my-app · Session Idle"],
    ["question", "my-app · Question Pending"],
    ["permission", "my-app · Permission Required"],
  ] as const)("%s card title starts with the project name", async (type, expected) => {
    const provider = new MSTeamsProvider({
      type: "msteams",
      enabled: true,
      webhookUrl: "https://teams.example.com/hook",
    });

    await provider.send(makeNotification(type));

    expect(bodies).toHaveLength(1);
    expect(sentTitle()).toBe(expected);
  });
});
