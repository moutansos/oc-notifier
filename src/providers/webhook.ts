/**
 * Generic webhook notification provider
 */

import type { WebhookProviderConfig } from "../config.ts";
import type { Notification, NotificationProvider } from "./types.ts";

export class WebhookProvider implements NotificationProvider {
  readonly type = "webhook";
  readonly enabled: boolean;
  private readonly url: string;
  private readonly method: "GET" | "POST" | "PUT";
  private readonly headers: Record<string, string>;

  constructor(config: WebhookProviderConfig) {
    this.enabled = config.enabled;
    this.url = config.url;
    this.method = config.method ?? "POST";
    this.headers = config.headers ?? {};
  }

  async send(notification: Notification): Promise<void> {
    const eventType = notification.type === "permission"
      ? "session.permission"
      : notification.type === "question"
        ? "session.question"
        : "session.idle";

    const body: Record<string, unknown> = {
      event: eventType,
      source: notification.source ?? "opencode",
      session: {
        id: notification.sessionId,
        title: notification.sessionTitle,
      },
      project: {
        id: notification.projectId,
        directory: notification.projectDirectory,
      },
      desktopUrl: notification.desktopUrl,
      timestamp: notification.timestamp.toISOString(),
    };

    // Add question text if present
    if (notification.question) {
      body.question = notification.question;
    }

    // Add permission details if present
    if (notification.permissionTitle) {
      body.permissionTitle = notification.permissionTitle;
    }
    if (notification.permissionType) {
      body.permissionType = notification.permissionType;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };

    const response = await fetch(this.url, {
      method: this.method,
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Webhook failed: ${response.status} ${text}`);
    }
  }
}
