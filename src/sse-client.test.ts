import { describe, expect, test } from "bun:test";
import { SSEClient, type QuestionEvent, type PermissionEvent } from "./sse-client.ts";

const opencodeConfig = {
  baseUrl: "http://127.0.0.1:4097",
  desktopBaseUrl: "https://oc.example.com",
};

const directory = "/home/dev/work/my-app";

function globalEvent(payload: Record<string, unknown>): string {
  return JSON.stringify({ directory, payload });
}

/** question.asked as OpenCode emits it for a multiple-choice ask */
function questionAsked(): string {
  return globalEvent({
    type: "question.asked",
    properties: {
      id: "que_123",
      sessionID: "ses_abc",
      questions: [
        {
          question: "Which database should we use?",
          header: "Database",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "Embedded" },
          ],
          multiple: true,
        },
      ],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  });
}

/** The question tool part OpenCode emits for the same ask */
function questionToolPart(): string {
  return globalEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        sessionID: "ses_abc",
        messageID: "msg_1",
        type: "tool",
        callID: "call_1",
        tool: "question",
        state: {
          status: "running",
          input: {
            questions: [
              {
                question: "Which database should we use?",
                header: "Database",
                options: [
                  { label: "Postgres", description: "Relational" },
                  { label: "SQLite", description: "Embedded" },
                ],
                multiple: true,
              },
            ],
          },
        },
      },
    },
  });
}

function collectQuestions(events: string[]): QuestionEvent[] {
  const client = new SSEClient(opencodeConfig);
  const received: QuestionEvent[] = [];
  client.onQuestion((question) => received.push(question));
  for (const event of events) {
    client.handleEventData(event);
  }
  return received;
}

describe("SSEClient question routing", () => {
  test("emits once when question.asked arrives before the question tool part", () => {
    const received = collectQuestions([questionAsked(), questionToolPart()]);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("que_123");
    expect(received[0]?.callID).toBe("call_1");
  });

  test("tool part fallback carries the call id so the ask can be correlated", () => {
    // Tool part first: the client cannot know yet that the server speaks v2, so
    // both are emitted — the call id lets the caller collapse them.
    const received = collectQuestions([questionToolPart(), questionAsked()]);

    expect(received).toHaveLength(2);
    expect(received[0]?.callID).toBe("call_1");
    expect(received[1]?.callID).toBe("call_1");
  });

  test("keeps the tool part fallback for servers that never send question.asked", () => {
    const received = collectQuestions([questionToolPart()]);

    expect(received).toHaveLength(1);
    expect(received[0]?.sessionID).toBe("ses_abc");
    expect(received[0]?.questions[0]?.question).toBe("Which database should we use?");
  });

  test("ignores question tool parts that are not running yet", () => {
    const pending = globalEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_1",
          sessionID: "ses_abc",
          messageID: "msg_1",
          type: "tool",
          callID: "call_1",
          tool: "question",
          state: { status: "pending", input: {} },
        },
      },
    });

    expect(collectQuestions([pending])).toHaveLength(0);
  });
});

describe("SSEClient permission routing", () => {
  const permissionAsked = globalEvent({
    type: "permission.asked",
    properties: {
      id: "per_1",
      sessionID: "ses_abc",
      permission: "edit",
      patterns: ["src/**"],
      metadata: {},
      always: ["src/**"],
      tool: { messageID: "msg_1", callID: "call_9" },
    },
  });

  const permissionUpdated = globalEvent({
    type: "permission.updated",
    properties: {
      id: "per_1",
      type: "edit",
      pattern: "src/**",
      sessionID: "ses_abc",
      messageID: "msg_1",
      callID: "call_9",
      title: "Edit src/index.ts",
      metadata: {},
      time: { created: 0 },
    },
  });

  function collectPermissions(events: string[]): PermissionEvent[] {
    const client = new SSEClient(opencodeConfig);
    const received: PermissionEvent[] = [];
    client.onPermission((permission) => received.push(permission));
    for (const event of events) {
      client.handleEventData(event);
    }
    return received;
  }

  test("drops the legacy permission.updated twin once permission.asked is seen", () => {
    const received = collectPermissions([permissionAsked, permissionUpdated]);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("per_1");
    expect(received[0]?.callID).toBe("call_9");
  });

  test("keeps permission.updated for servers that never send permission.asked", () => {
    const received = collectPermissions([permissionUpdated]);

    expect(received).toHaveLength(1);
    expect(received[0]?.title).toBe("Edit src/index.ts");
    expect(received[0]?.callID).toBe("call_9");
  });
});
