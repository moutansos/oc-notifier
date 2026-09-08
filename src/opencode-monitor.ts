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
import type { Notification, NotificationChoice, NotificationSource } from "./providers/types.ts";

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
  /**
   * Public URL of this OpenCode server as the web UI identifies it.
   * Used for OpenCode 2 `/server/{base64(serverUrl)}/session/{id}` links.
   */
  serverUrl?: string;
  /** Which OpenCode server produced the event ("opencode" or "opencode2") */
  source: NotificationSource;
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

    // OpenCode 2 events omit the location, so fall back to the session's own directory
    const projectDirectory = directory || sessionInfo?.directory || "";

    await deps.send({
      type: "question",
      source: deps.source,
      sessionId: sessionID,
      sessionTitle: sessionInfo?.title || sessionID,
      projectId: sessionInfo?.projectID || "",
      projectDirectory,
      desktopUrl: buildDesktopUrl(deps.desktopBaseUrl, projectDirectory, sessionID, {
        source: deps.source,
        serverUrl: deps.serverUrl,
      }),
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

    // OpenCode 2 events omit the location, so fall back to the session's own directory
    const projectDirectory = directory || sessionInfo?.directory || "";

    await deps.send({
      type: "permission",
      source: deps.source,
      sessionId: sessionID,
      sessionTitle: sessionInfo?.title || sessionID,
      projectId: sessionInfo?.projectID || "",
      projectDirectory,
      desktopUrl: buildDesktopUrl(deps.desktopBaseUrl, projectDirectory, sessionID, {
        source: deps.source,
        serverUrl: deps.serverUrl,
      }),
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

/** Strip trailing slashes and ensure an http(s) scheme, matching OpenCode's normalizeServerUrl. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export interface DesktopUrlOptions {
  /** Which OpenCode UI to target. v2 uses server-keyed routes. */
  source?: NotificationSource;
  /**
   * Public URL of the OpenCode 2 server as registered in the web UI.
   * Ignored for v1 directory-keyed links.
   */
  serverUrl?: string;
}

/**
 * Build a deep link to a session in the OpenCode web/desktop UI.
 *
 * OpenCode v1 (legacy): `/{base64(directory)}/session/{sessionId}`
 * OpenCode 2: `/server/{base64(serverUrl)}/session/{sessionId}`
 *
 * @see https://github.com/anomalyco/opencode/blob/dev/packages/app/src/utils/session-route.ts
 */
export function buildDesktopUrl(
  desktopBaseUrl: string,
  directory: string,
  sessionId: string,
  options: DesktopUrlOptions = {},
): string {
  const origin = desktopBaseUrl.replace(/\/$/, "");
  if (options.source === "opencode2") {
    const encodedServer = base64Encode(normalizeServerUrl(options.serverUrl ?? ""));
    return `${origin}/server/${encodedServer}/session/${sessionId}`;
  }
  const encodedDirectory = base64Encode(directory);
  return `${origin}/${encodedDirectory}/session/${sessionId}`;
}
