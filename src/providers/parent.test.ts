import { describe, expect, test } from "bun:test";
import { joinNotifyUrl, ParentProvider } from "./parent.ts";
import type { Notification } from "./types.ts";

describe("joinNotifyUrl", () => {
  test("appends /v1/notify to base URL", () => {
    expect(joinNotifyUrl("http://parent:4100")).toBe("http://parent:4100/v1/notify");
    expect(joinNotifyUrl("http://parent:4100/")).toBe("http://parent:4100/v1/notify");
  });

  test("leaves a full notify URL unchanged", () => {
    expect(joinNotifyUrl("http://parent:4100/v1/notify")).toBe(
      "http://parent:4100/v1/notify"
    );
    expect(joinNotifyUrl("http://parent:4100/v1/notify/")).toBe(
      "http://parent:4100/v1/notify"
    );
  });
});

describe("ParentProvider", () => {
  test("POSTs normalized payload with hostname and desktopUrl preserved", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const provider = new ParentProvider({
        type: "parent",
        enabled: true,
        url: "http://central:4100",
        token: "secret",
      });

      const notification: Notification = {
        type: "idle",
        source: "opencode",
        sessionId: "ses_123",
        sessionTitle: "Fix bug",
        projectId: "proj_1",
        projectDirectory: "/home/dev/work/my-app",
        desktopUrl: "https://child-desktop.example.com/session/ses_123",
        hostname: "devbox",
        timestamp: new Date("2026-08-04T12:00:00.000Z"),
      };

      await provider.send(notification);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://central:4100/v1/notify");

      const headers = requests[0]?.init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Authorization).toBe("Bearer secret");

      const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
      expect(body).toEqual({
        type: "idle",
        source: "opencode",
        sessionId: "ses_123",
        sessionTitle: "Fix bug",
        projectId: "proj_1",
        projectDirectory: "/home/dev/work/my-app",
        desktopUrl: "https://child-desktop.example.com/session/ses_123",
        timestamp: "2026-08-04T12:00:00.000Z",
        hostname: "devbox",
        hops: 1,
      });
      expect(requests[0]?.init.signal).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when parent responds non-OK", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;

    try {
      const provider = new ParentProvider({
        type: "parent",
        enabled: true,
        url: "http://central:4100",
      });

      await expect(
        provider.send({
          type: "idle",
          sessionId: "ses_1",
          sessionTitle: "t",
          projectId: "",
          projectDirectory: "/tmp/x",
          desktopUrl: "",
          timestamp: new Date(),
        })
      ).rejects.toThrow("Parent instance notify failed: 503");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects when hop limit is exceeded", async () => {
    const provider = new ParentProvider({
      type: "parent",
      enabled: true,
      url: "http://central:4100",
      maxHops: 2,
    });

    await expect(
      provider.send({
        type: "idle",
        sessionId: "ses_1",
        sessionTitle: "t",
        projectId: "",
        projectDirectory: "/tmp/x",
        desktopUrl: "",
        timestamp: new Date(),
        hops: 2,
      })
    ).rejects.toThrow("Parent forward hop limit exceeded");
  });
});
