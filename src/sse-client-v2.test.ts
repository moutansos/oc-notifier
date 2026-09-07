import { describe, expect, test } from "bun:test";
import {
  classifyV2SessionEvent,
  normalizePermissionRequest,
  normalizeQuestionRequest,
  parseV2EventData,
} from "./sse-client-v2.ts";

describe("parseV2EventData", () => {
  test("parses a native V2 event envelope", () => {
    const event = parseV2EventData(JSON.stringify({
      id: "evt_1",
      type: "permission.asked",
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
      type: "permission.asked",
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
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" },
    });
    const event = parseV2EventData(JSON.stringify(inner));
    expect(event?.type).toBe("session.execution.succeeded");
    expect(event?.data?.sessionID).toBe("ses_1");
  });

  test("returns null for events without a type", () => {
    expect(parseV2EventData(JSON.stringify({ data: {} }))).toBeNull();
  });

  test("tolerates idle events that omit the location", () => {
    // session.execution.* carries no location; the directory comes from
    // fetchSessionInfo instead.
    const event = parseV2EventData(JSON.stringify({
      id: "evt_2",
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" },
      durable: { aggregateID: "ses_1", seq: 490, version: 1 },
    }));

    expect(event?.type).toBe("session.execution.succeeded");
    expect(event?.location).toBeUndefined();
  });
});

describe("classifyV2SessionEvent", () => {
  test("classifies busy events", () => {
    expect(classifyV2SessionEvent("session.step.started")).toBe("busy");
    expect(classifyV2SessionEvent("session.execution.started")).toBe("busy");
    expect(classifyV2SessionEvent("session.compaction.started")).toBe("busy");
    expect(classifyV2SessionEvent("session.retry.scheduled")).toBe("busy");
  });

  test("classifies idle-candidate events", () => {
    expect(classifyV2SessionEvent("session.execution.succeeded")).toBe("idle");
    expect(classifyV2SessionEvent("session.execution.failed")).toBe("idle");
    expect(classifyV2SessionEvent("session.execution.interrupted")).toBe("idle");
  });

  test("does not treat mid-turn step ends as idle", () => {
    // session.step.ended fires between every tool call within a turn; treating
    // it as idle notifies long before the assistant is actually done.
    expect(classifyV2SessionEvent("session.step.ended")).toBeNull();
    expect(classifyV2SessionEvent("session.step.streamed")).toBeNull();
  });

  test("ignores unrelated events", () => {
    expect(classifyV2SessionEvent("session.text.delta")).toBeNull();
    expect(classifyV2SessionEvent("session.tool.success")).toBeNull();
    expect(classifyV2SessionEvent("form.created")).toBeNull();
    expect(classifyV2SessionEvent("permission.asked")).toBeNull();
    expect(classifyV2SessionEvent("server.connected")).toBeNull();
    // The v1-style status event does not exist on the v2 stream.
    expect(classifyV2SessionEvent("session.status")).toBeNull();
  });
});

// Payloads below are captured verbatim from a live OpenCode 2 /api/event stream.
describe("normalizePermissionRequest", () => {
  const asked = {
    id: "per_078c4e261001vjZPoQTl8p4Lqs",
    sessionID: "ses_f873b1da6ffenvbRcP5Cm8kvv4",
    action: "bash",
    resources: ["rm -rf /tmp/opencode/perm-probe"],
    save: ["bash:rm *"],
    metadata: { command: "rm -rf /tmp/opencode/perm-probe", probe: true },
    source: { type: "tool", messageID: "msg_probe", id: "call_probe_123" },
  };

  test("normalizes a real permission.asked payload", () => {
    const permission = normalizePermissionRequest(asked);

    expect(permission).not.toBeNull();
    expect(permission?.id).toBe("per_078c4e261001vjZPoQTl8p4Lqs");
    expect(permission?.sessionID).toBe("ses_f873b1da6ffenvbRcP5Cm8kvv4");
    expect(permission?.permissionType).toBe("bash");
    expect(permission?.title).toBe("bash: rm -rf /tmp/opencode/perm-probe");
    expect(permission?.patterns).toEqual(["rm -rf /tmp/opencode/perm-probe"]);
    expect(permission?.alwaysPatterns).toEqual(["bash:rm *"]);
  });

  test("reads the tool call id from source, not a tool field", () => {
    expect(normalizePermissionRequest(asked)?.callID).toBe("call_probe_123");
  });

  test("falls back to resources when no save patterns are given", () => {
    const { save, ...withoutSave } = asked;
    expect(normalizePermissionRequest(withoutSave)?.alwaysPatterns).toEqual([
      "rm -rf /tmp/opencode/perm-probe",
    ]);
  });

  test("returns null when required fields are missing", () => {
    expect(normalizePermissionRequest({ action: "bash" })).toBeNull();
  });
});

describe("normalizeQuestionRequest", () => {
  const created = {
    form: {
      id: "frm_078c20405001y9daJ4n9KVz0pP",
      sessionID: "ses_f8740d0bdffeMP2J3I5LGKzZVp",
      title: "Questions",
      metadata: {
        kind: "question",
        tool: { messageID: "msg_078c1a44b001GOJtoYE31o6m4N", id: "toolu_01BaLVnRHDPsRYTbdLqxH8br" },
      },
      fields: [
        {
          key: "q0",
          title: "Fix approach",
          description: "How do you want me to fix the OpenCode 2 event mapping?",
          type: "string",
          options: [
            { value: "Minimal rename only", label: "Minimal rename only", description: "Smallest diff" },
            { value: "Investigate first", label: "Investigate first", description: "Capture real payloads" },
          ],
          custom: true,
        },
      ],
    },
  };

  test("normalizes a real form.created payload", () => {
    const question = normalizeQuestionRequest(created);

    expect(question).not.toBeNull();
    expect(question?.id).toBe("frm_078c20405001y9daJ4n9KVz0pP");
    expect(question?.sessionID).toBe("ses_f8740d0bdffeMP2J3I5LGKzZVp");
    expect(question?.questions).toHaveLength(1);
    expect(question?.questions[0]?.header).toBe("Fix approach");
    expect(question?.questions[0]?.question).toBe(
      "How do you want me to fix the OpenCode 2 event mapping?"
    );
    expect(question?.questions[0]?.options.map((o) => o.label)).toEqual([
      "Minimal rename only",
      "Investigate first",
    ]);
  });

  test("reads the tool call id from form metadata", () => {
    expect(normalizeQuestionRequest(created)?.callID).toBe("toolu_01BaLVnRHDPsRYTbdLqxH8br");
  });

  test("ignores forms that are not questions", () => {
    const other = { form: { ...created.form, metadata: { kind: "elicitation" } } };
    expect(normalizeQuestionRequest(other)).toBeNull();
  });

  test("returns null for a flat payload without the form wrapper", () => {
    expect(normalizeQuestionRequest({ id: "frm_1", sessionID: "ses_1" })).toBeNull();
  });

  test("falls back to the form title when it has no fields", () => {
    const empty = { form: { ...created.form, fields: [] } };
    expect(normalizeQuestionRequest(empty)?.questions[0]?.question).toBe("Questions");
  });
});
