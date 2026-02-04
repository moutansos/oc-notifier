/**
 * Provider interface and notification types
 */

export interface Notification {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectDirectory: string;
  desktopUrl: string;
  timestamp: Date;
}

export interface NotificationProvider {
  readonly type: string;
  readonly enabled: boolean;
  send(notification: Notification): Promise<void>;
}
