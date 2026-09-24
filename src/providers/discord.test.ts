import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DiscordProvider } from "./discord.ts";
import type { Notification } from "./types.ts";

describe("DiscordProvider", () => {
  const originalFetch = globalThis.fetch;
  let bodies: Array<{ embeds: Array<{ title: string }> }>;

  beforeEach(() => {
    bodies = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const provider = new DiscordProvider({
    type: "discord",
    enabled: true,
    webhookUrl: "https://discord.example.com/api/webhooks/1/abc",
  });

  const notification: Notification = {
    type: "idle",
    source: "opencode",
    sessionId: "ses_123",
    sessionTitle: "Fix bug",
    projectId: "proj_1",
    projectDirectory: "/home/dev/work/my-app/",
    desktopUrl: "",
    hostname: "devbox",
    timestamp: new Date("2026-08-04T12:00:00.000Z"),
  };

  test("embed title starts with the project name", async () => {
    await provider.send(notification);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.embeds[0]?.title).toBe("my-app · Fix bug");
  });

  test("embed title falls back to the session id when there is no title", async () => {
    await provider.send({ ...notification, sessionTitle: "" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.embeds[0]?.title).toBe("my-app · ses_123");
  });
});
