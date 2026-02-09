/**
 * Provider interface and notification types
 */

export type NotificationType = "idle" | "question";

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
}

export interface NotificationProvider {
  readonly type: string;
  readonly enabled: boolean;
  send(notification: Notification): Promise<void>;
}
