import { describe, expect, test } from "bun:test";
import { classifyV2SessionEvent, parseV2EventData } from "./sse-client-v2.ts";

describe("parseV2EventData", () => {
  test("parses a native V2 event envelope", () => {
    const event = parseV2EventData(JSON.stringify({
      id: "evt_1",
      type: "permission.v2.asked",
      location: { directory: "/home/dev/proj" },
      data: {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["git push *"],
      },
    }));

    expect(event).toEqual({
      id: "evt_1",
      type: "permission.v2.asked",
      location: { directory: "/home/dev/proj" },
      data: {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["git push *"],
      },
    });
  });

  test("parses double-encoded JSON data", () => {
    const inner = JSON.stringify({
      type: "session.next.step.ended",
      data: { sessionID: "ses_1" },
    });
    const event = parseV2EventData(JSON.stringify(inner));
    expect(event?.type).toBe("session.next.step.ended");
    expect(event?.data?.sessionID).toBe("ses_1");
  });

  test("returns null for events without a type", () => {
    expect(parseV2EventData(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe("classifyV2SessionEvent", () => {
  test("classifies busy events", () => {
    expect(classifyV2SessionEvent("session.next.step.started")).toBe("busy");
    expect(classifyV2SessionEvent("session.next.prompted")).toBe("busy");
    expect(classifyV2SessionEvent("session.next.retried")).toBe("busy");
    expect(classifyV2SessionEvent("session.next.compaction.started")).toBe("busy");
  });

  test("classifies idle-candidate events", () => {
    expect(classifyV2SessionEvent("session.next.step.ended")).toBe("idle");
    expect(classifyV2SessionEvent("session.next.step.failed")).toBe("idle");
    expect(classifyV2SessionEvent("session.next.compaction.ended")).toBe("idle");
  });

  test("ignores unrelated events", () => {
    expect(classifyV2SessionEvent("session.next.text.delta")).toBeNull();
    expect(classifyV2SessionEvent("session.next.tool.success")).toBeNull();
    expect(classifyV2SessionEvent("question.v2.asked")).toBeNull();
    expect(classifyV2SessionEvent("server.connected")).toBeNull();
  });
});
