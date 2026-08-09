import { describe, expect, test } from "bun:test";
import { EventDeduper } from "./event-dedupe.ts";
import { createPermissionHandler, createQuestionHandler, type MonitorDeps } from "./opencode-monitor.ts";
import { Notifier } from "./notifier.ts";
import type { PermissionEvent, QuestionEvent, SessionInfo } from "./sse-client.ts";
import type { Notification, NotificationProvider } from "./providers/types.ts";

const directory = "/home/dev/work/my-app";

/** question.asked as OpenCode publishes it for a tool-driven ask */
const questionAsked: QuestionEvent = {
  id: "que_123",
  sessionID: "ses_abc",
  callID: "call_1",
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
};

/** The same ask as seen through the question tool part (legacy path) */
const questionToolPart: QuestionEvent = {
  ...questionAsked,
  // The tool-part path has no request id of its own; it derives one.
  id: "ses_abc:call_1",
};

const permissionAsked: PermissionEvent = {
  id: "per_1",
  sessionID: "ses_abc",
  callID: "call_9",
  title: "edit: src/**",
  permissionType: "edit",
  patterns: ["src/**"],
  alwaysPatterns: ["src/**"],
  metadata: {},
};

/**
 * The same request seen through the legacy event. A server that emits both
 * normally reuses the permission record id, so the id alone would already
 * collapse them — this fixture varies the id so the tool call is what has to
 * do the correlating.
 */
const permissionUpdated: PermissionEvent = {
  ...permissionAsked,
  id: "per_legacy_1",
  title: "Edit src/index.ts",
};

interface Harness {
  deps: MonitorDeps;
  sent: Notification[];
}

function harness(sessionInfo: SessionInfo | null = null): Harness {
  const sent: Notification[] = [];
  const ttlMs = 30 * 60 * 1000;

  return {
    sent,
    deps: {
      questions: new EventDeduper(ttlMs),
      permissions: new EventDeduper(ttlMs),
      knownSubagents: new Set<string>(),
      fetchSessionInfo: async () => sessionInfo,
      send: async (notification) => {
        sent.push(notification);
      },
      desktopBaseUrl: "https://oc.example.com",
    },
  };
}

describe("question handler (issue 11: one card per ask)", () => {
  test("tool part then question.asked sends one notification", async () => {
    const { deps, sent } = harness();
    const handle = createQuestionHandler(deps);

    // Real wire order: the tool goes running, then execute() publishes the ask.
    await handle(questionToolPart, directory);
    await handle(questionAsked, directory);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("question");
    expect(sent[0]?.question).toBe("Database: Which database should we use?");
  });

  test("question.asked then tool part sends one notification", async () => {
    const { deps, sent } = harness();
    const handle = createQuestionHandler(deps);

    await handle(questionAsked, directory);
    await handle(questionToolPart, directory);

    expect(sent).toHaveLength(1);
  });

  test("claims the ask before it starts fetching session info", async () => {
    // The reservation has to be taken before the await, not after it: anything
    // that arrives while the fetch is in flight must already see it claimed.
    const { deps } = harness();
    let claimedWhenFetchStarted = 0;
    deps.fetchSessionInfo = async () => {
      claimedWhenFetchStarted = deps.questions.size;
      return null;
    };

    await createQuestionHandler(deps)(questionAsked, directory);

    expect(claimedWhenFetchStarted).toBeGreaterThan(0);
  });

  test("sends one notification for events that overlap in flight", async () => {
    const { deps, sent } = harness();
    // Hold both handlers inside fetchSessionInfo so neither has notified when
    // the other starts: the reservation has to be taken before that await.
    let release = () => {};
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.fetchSessionInfo = async () => {
      await holding;
      return null;
    };
    const handle = createQuestionHandler(deps);

    const inFlight = Promise.all([
      handle(questionToolPart, directory),
      handle(questionAsked, directory),
      handle(questionAsked, directory),
    ]);
    release();
    await inFlight;

    expect(sent).toHaveLength(1);
  });

  test("a replayed question.asked after reconnect sends nothing new", async () => {
    const { deps, sent } = harness();
    const handle = createQuestionHandler(deps);

    await handle(questionAsked, directory);
    await handle(questionAsked, directory);

    expect(sent).toHaveLength(1);
  });

  test("a genuinely different ask in the same session still notifies", async () => {
    const { deps, sent } = harness();
    const handle = createQuestionHandler(deps);

    await handle(questionAsked, directory);
    await handle(
      { ...questionAsked, id: "que_456", callID: "call_2" },
      directory
    );

    expect(sent).toHaveLength(2);
  });

  test("includes every option plus the custom-answer choice", async () => {
    const { deps, sent } = harness();

    await createQuestionHandler(deps)(questionAsked, directory);

    expect(sent[0]?.choices?.map((choice) => choice.label)).toEqual([
      "Postgres",
      "SQLite",
      "Custom answer",
    ]);
  });

  test("skips subagent sessions and remembers them", async () => {
    const { deps, sent } = harness({
      id: "ses_abc",
      parentSessionID: "ses_parent",
      title: "Subagent",
      projectID: "proj_1",
    });
    const handle = createQuestionHandler(deps);

    await handle(questionAsked, directory);

    expect(sent).toHaveLength(0);
    expect(deps.knownSubagents.has("ses_abc")).toBe(true);
  });

  test("an ask with no tool call falls back to the notifier's content dedupe", async () => {
    // Nothing correlates the two paths when question.asked omits `tool`, so both
    // reach the notifier — which collapses them by session + question text.
    // That backstop only holds while both paths render the same text, which is
    // true as long as the tool part carries the ask's complete input.
    const captured: Notification[] = [];
    const capture: NotificationProvider = {
      type: "capture",
      enabled: true,
      send: async (notification) => {
        captured.push(notification);
      },
    };
    const notifier = new Notifier([capture]);
    const { deps } = harness();
    deps.send = (notification) => notifier.send(notification);

    const handle = createQuestionHandler(deps);
    await handle({ ...questionToolPart, callID: undefined }, directory);
    await handle({ ...questionAsked, callID: undefined }, directory);

    expect(captured).toHaveLength(1);
  });
});

describe("permission handler", () => {
  test("collapses the v2 event and its legacy twin by tool call id", async () => {
    const { deps, sent } = harness();
    const handle = createPermissionHandler(deps);

    await handle(permissionAsked, directory);
    await handle(permissionUpdated, directory);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.permissionTitle).toBe("edit: src/**");
  });

  test("a replayed permission request sends nothing new", async () => {
    const { deps, sent } = harness();
    const handle = createPermissionHandler(deps);

    await handle(permissionAsked, directory);
    await handle(permissionAsked, directory);

    expect(sent).toHaveLength(1);
  });

  test("a question and a permission sharing a tool call both notify", async () => {
    // OpenCode asserts the "question" permission for the same callID as the ask,
    // so the two key namespaces must not collide.
    const { deps, sent } = harness();

    await createQuestionHandler(deps)(questionAsked, directory);
    await createPermissionHandler(deps)(
      { ...permissionAsked, callID: "call_1" },
      directory
    );

    expect(sent.map((notification) => notification.type)).toEqual([
      "question",
      "permission",
    ]);
  });
});
