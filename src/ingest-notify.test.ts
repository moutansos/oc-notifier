import { describe, expect, test } from "bun:test";
import { parseNotifyBody } from "./ingest-server.ts";
import { Notifier } from "./notifier.ts";
import type { Notification, NotificationProvider } from "./providers/types.ts";

describe("parseNotifyBody (parent identity)", () => {
  test("preserves hostname, desktopUrl, projectDirectory, and ISO timestamp", () => {
    const notification = parseNotifyBody({
      type: "idle",
      source: "opencode",
      sessionId: "ses_abc",
      sessionTitle: "Ship it",
      projectId: "proj_1",
      projectDirectory: "/home/dev/apps/oc-notifier",
      desktopUrl: "https://child.example.com/s/ses_abc",
      hostname: "devbox.local",
      timestamp: "2026-08-04T15:30:00.000Z",
      hops: 1,
    });

    expect(notification.hostname).toBe("devbox.local");
    expect(notification.desktopUrl).toBe("https://child.example.com/s/ses_abc");
    expect(notification.projectDirectory).toBe("/home/dev/apps/oc-notifier");
    expect(notification.sessionTitle).toBe("Ship it");
    expect(notification.timestamp.toISOString()).toBe("2026-08-04T15:30:00.000Z");
    expect(notification.hops).toBe(1);
  });

  test("falls back to current time when timestamp is invalid", () => {
    const before = Date.now();
    const notification = parseNotifyBody({
      type: "question",
      sessionId: "ses_q",
      timestamp: "not-a-date",
    });
    const after = Date.now();

    expect(notification.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(notification.timestamp.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("Notifier hostname stamping", () => {
  test("does not overwrite a pre-set child hostname", async () => {
    let received: Notification | undefined;
    const provider: NotificationProvider = {
      type: "capture",
      enabled: true,
      async send(n) {
        received = n;
      },
    };

    const notifier = new Notifier([provider]);
    await notifier.send({
      type: "idle",
      sessionId: "ses_1",
      sessionTitle: "t",
      projectId: "",
      projectDirectory: "/home/dev/proj",
      desktopUrl: "https://child/x",
      hostname: "edge-host",
      timestamp: new Date(),
    });

    expect(received?.hostname).toBe("edge-host");
  });

  test("stamps local hostname when missing", async () => {
    let received: Notification | undefined;
    const provider: NotificationProvider = {
      type: "capture",
      enabled: true,
      async send(n) {
        received = n;
      },
    };

    const notifier = new Notifier([provider]);
    await notifier.send({
      type: "idle",
      sessionId: "ses_2",
      sessionTitle: "t",
      projectId: "",
      projectDirectory: "/home/dev/proj",
      desktopUrl: "",
      timestamp: new Date(),
    });

    expect(received?.hostname).toBeTruthy();
    expect(typeof received?.hostname).toBe("string");
  });
});

describe("Notifier dedupe", () => {
  test("suppresses a second identical idle within the window", async () => {
    let sends = 0;
    const provider: NotificationProvider = {
      type: "capture",
      enabled: true,
      async send() {
        sends += 1;
      },
    };

    const notifier = new Notifier([provider], [], 15_000);
    const note: Notification = {
      type: "idle",
      source: "opencode",
      sessionId: "ses_dup",
      sessionTitle: "t",
      projectId: "",
      projectDirectory: "/home/dev/proj",
      desktopUrl: "",
      hostname: "k8s-ubuntu-dev1-0",
      timestamp: new Date(),
    };

    await notifier.send(note);
    await notifier.send({ ...note, timestamp: new Date() });
    expect(sends).toBe(1);
  });

  test("allows a different session through", async () => {
    let sends = 0;
    const provider: NotificationProvider = {
      type: "capture",
      enabled: true,
      async send() {
        sends += 1;
      },
    };

    const notifier = new Notifier([provider], [], 15_000);
    const base = {
      type: "idle" as const,
      source: "opencode" as const,
      sessionTitle: "t",
      projectId: "",
      projectDirectory: "/home/dev/proj",
      desktopUrl: "",
      hostname: "edge",
      timestamp: new Date(),
    };

    await notifier.send({ ...base, sessionId: "ses_a" });
    await notifier.send({ ...base, sessionId: "ses_b" });
    expect(sends).toBe(2);
  });
});
