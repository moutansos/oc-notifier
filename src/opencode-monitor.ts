/**
 * Handlers for OpenCode question and permission events.
 *
 * Split out of index.ts so the duplicate-suppression behaviour can be tested
 * without standing up an SSE connection: one ask reaches these handlers twice
 * (question.asked and the question tool part) and must produce one notification.
 */

import type { EventDeduper } from "./event-dedupe.ts";
import { permissionKeys, questionKeys } from "./event-dedupe.ts";
import type { PermissionEvent, QuestionEvent, SessionInfo } from "./sse-client.ts";
import type { Notification, NotificationChoice } from "./providers/types.ts";

export interface MonitorDeps {
  /** Reservations for question requests (id + tool call) */
  questions: EventDeduper;
  /** Reservations for permission requests (id + tool call) */
  permissions: EventDeduper;
  /** Sessions already identified as subagents; notifications for them are skipped */
  knownSubagents: Set<string>;
  fetchSessionInfo(sessionID: string, directory: string): Promise<SessionInfo | null>;
  send(notification: Notification): Promise<void>;
  desktopBaseUrl: string;
}

export function createQuestionHandler(
  deps: MonitorDeps
): (question: QuestionEvent, directory: string) => Promise<void> {
  return async (question, directory) => {
    const { sessionID } = question;

    // Skip known subagent sessions
    if (deps.knownSubagents.has(sessionID)) {
      return;
    }

    // Reserve before awaiting session info: the two events describing one ask
    // arrive milliseconds apart and would both pass a check made after the
    // await. Every path below this point either notifies or suppresses on
    // purpose, so the reservation is never released.
    if (!deps.questions.reserve(questionKeys(question))) {
      return;
    }

    const questionText = formatQuestionText(question);
    console.log(`Question asked in session ${sessionID}, sending notification...`);

    const sessionInfo = await deps.fetchSessionInfo(sessionID, directory);

    if (sessionInfo?.parentSessionID) {
      console.log(`Session ${sessionID} is a subagent, skipping question notification`);
      deps.knownSubagents.add(sessionID);
      return;
    }

    await deps.send({
      type: "question",
      source: "opencode",
      sessionId: sessionID,
      sessionTitle: sessionInfo?.title || sessionID,
      projectId: sessionInfo?.projectID || "",
      projectDirectory: directory,
      desktopUrl: buildDesktopUrl(deps.desktopBaseUrl, directory, sessionID),
      timestamp: new Date(),
      question: questionText,
      choices: buildQuestionChoices(question),
    });
  };
}

export function createPermissionHandler(
  deps: MonitorDeps
): (permission: PermissionEvent, directory: string) => Promise<void> {
  return async (permission, directory) => {
    const { sessionID } = permission;

    // Skip known subagent sessions
    if (deps.knownSubagents.has(sessionID)) {
      return;
    }

    // Reserve before awaiting session info (see the question handler).
    if (!deps.permissions.reserve(permissionKeys(permission))) {
      return;
    }

    console.log(
      `Permission request "${permission.title}" in session ${sessionID}, sending notification...`
    );

    const sessionInfo = await deps.fetchSessionInfo(sessionID, directory);

    if (sessionInfo?.parentSessionID) {
      console.log(`Session ${sessionID} is a subagent, skipping permission notification`);
      deps.knownSubagents.add(sessionID);
      return;
    }

    await deps.send({
      type: "permission",
      source: "opencode",
      sessionId: sessionID,
      sessionTitle: sessionInfo?.title || sessionID,
      projectId: sessionInfo?.projectID || "",
      projectDirectory: directory,
      desktopUrl: buildDesktopUrl(deps.desktopBaseUrl, directory, sessionID),
      timestamp: new Date(),
      permissionTitle: permission.title,
      permissionType: permission.permissionType,
      choices: buildPermissionChoices(permission),
    });
  };
}

export function formatQuestionText(question: QuestionEvent): string {
  return question.questions
    .map((item) => item.header ? `${item.header}: ${item.question}` : item.question)
    .join("\n\n");
}

export function buildQuestionChoices(question: QuestionEvent): NotificationChoice[] {
  const choices: NotificationChoice[] = [];

  for (const item of question.questions) {
    for (const option of item.options) {
      choices.push({
        label: option.label,
        description: option.description,
      });
    }

    if (item.custom !== false) {
      choices.push({
        label: "Custom answer",
        description: "Type your own response in OpenCode",
      });
    }
  }

  return choices;
}

export function buildPermissionChoices(permission: PermissionEvent): NotificationChoice[] {
  const alwaysDescription = permission.alwaysPatterns.length > 0
    ? `Approve future requests matching: ${permission.alwaysPatterns.join(", ")}`
    : "Approve future matching requests for this session";

  return [
    { label: "Once", description: "Approve just this request" },
    { label: "Always", description: alwaysDescription },
    { label: "Reject", description: "Deny the request" },
  ];
}

/** Matches OpenCode's base64url encoding from @opencode-ai/core/util/encode */
function base64Encode(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Build a deep link to a session in the OpenCode web/desktop UI.
 * Uses the directory-keyed route: /{base64(directory)}/session/{sessionId}
 * @see https://github.com/anomalyco/opencode/blob/dev/packages/app/src/utils/session-route.ts
 */
export function buildDesktopUrl(
  baseUrl: string,
  directory: string,
  sessionId: string
): string {
  const encodedDirectory = base64Encode(directory);
  return `${baseUrl.replace(/\/$/, "")}/${encodedDirectory}/session/${sessionId}`;
}
