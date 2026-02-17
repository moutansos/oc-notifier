/**
 * Provider interface and notification types
 */

export type NotificationType = "idle" | "question" | "permission";

export interface Notification {
  type: NotificationType;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectDirectory: string;
  desktopUrl: string;
  timestamp: Date;
  /** Question text when type is "question" */
  question?: string;
  /** Permission title when type is "permission" (e.g. "Edit src/index.ts") */
  permissionTitle?: string;
  /** Permission type when type is "permission" (e.g. "edit", "bash", "webfetch") */
  permissionType?: string;
}

export interface NotificationProvider {
  readonly type: string;
  readonly enabled: boolean;
  send(notification: Notification): Promise<void>;
}
