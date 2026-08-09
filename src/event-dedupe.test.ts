import { describe, expect, test } from "bun:test";
import { EventDeduper, permissionKeys, questionKeys } from "./event-dedupe.ts";

describe("EventDeduper", () => {
  test("reserves once and rejects a repeat of the same key", () => {
    const deduper = new EventDeduper(60_000);

    expect(deduper.reserve(["a"])).toBe(true);
    expect(deduper.reserve(["a"])).toBe(false);
  });

  test("rejects when any key overlaps an earlier reservation", () => {
    const deduper = new EventDeduper(60_000);

    expect(deduper.reserve(["question:que_1", "question:tool:ses_1:call_1"])).toBe(true);
    // Same ask arriving via the other event path: different id, same call id.
    expect(deduper.reserve(["question:tool:ses_1:call_1"])).toBe(false);
  });

  test("does not partially reserve a rejected event", () => {
    const deduper = new EventDeduper(60_000);

    deduper.reserve(["a"]);
    expect(deduper.reserve(["a", "b"])).toBe(false);
    // "b" was never claimed, so a later event carrying it still goes through.
    expect(deduper.reserve(["b"])).toBe(true);
  });

  test("forgets reservations older than the TTL", () => {
    const deduper = new EventDeduper(0);

    expect(deduper.reserve(["a"])).toBe(true);
    expect(deduper.reserve(["a"])).toBe(true);
    expect(deduper.size).toBe(0);
  });
});

describe("questionKeys / permissionKeys", () => {
  test("question.asked and its tool part produce an overlapping key", () => {
    const fromEvent = questionKeys({ id: "que_1", sessionID: "ses_1", callID: "call_1" });
    const fromToolPart = questionKeys({
      id: "ses_1:call_1",
      sessionID: "ses_1",
      callID: "call_1",
    });

    expect(fromEvent).toContain("question:tool:ses_1:call_1");
    expect(fromToolPart).toContain("question:tool:ses_1:call_1");
  });

  test("falls back to the request id when no tool call is attached", () => {
    expect(questionKeys({ id: "que_1", sessionID: "ses_1" })).toEqual(["question:que_1"]);
    expect(permissionKeys({ id: "per_1", sessionID: "ses_1" })).toEqual([
      "permission:per_1",
    ]);
  });

  test("question and permission keys never collide", () => {
    const question = questionKeys({ id: "x", sessionID: "ses_1", callID: "call_1" });
    const permission = permissionKeys({ id: "x", sessionID: "ses_1", callID: "call_1" });

    expect(question.some((key) => permission.includes(key))).toBe(false);
  });
});
