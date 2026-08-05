/**
 * Microsoft Teams webhook notification provider
 * Uses Adaptive Cards format for rich notifications
 */

import type { MSTeamsProviderConfig } from "../config.ts";
import type { Notification, NotificationProvider } from "./types.ts";
import { sourceLabel } from "./types.ts";

export class MSTeamsProvider implements NotificationProvider {
  readonly type = "msteams";
  readonly enabled: boolean;
  private readonly webhookUrl: string;

  constructor(config: MSTeamsProviderConfig) {
    this.enabled = config.enabled;
    this.webhookUrl = config.webhookUrl;
  }

  async send(notification: Notification): Promise<void> {
    // Extract just the project folder name from the full path
    const projectName =
      notification.projectDirectory.split("/").filter(Boolean).pop() ||
      notification.projectDirectory ||
      "project";
    const source = sourceLabel(notification.source);
    const hasLink = Boolean(notification.desktopUrl);

    const isQuestion = notification.type === "question";
    const isPermission = notification.type === "permission";
    const title = isPermission
      ? `Permission Required: ${projectName}`
      : isQuestion
        ? `Question Pending: ${projectName}`
        : `Session Idle: ${projectName}`;
    const status = isPermission
      ? "Waiting for permission"
      : isQuestion ? "Waiting for your response" : "Ready for input";

    const bodyElements: unknown[] = [
      {
        type: "TextBlock",
        size: "Large",
        weight: "Bolder",
        text: title,
        style: "heading",
        color: isPermission ? "attention" : isQuestion ? "warning" : "default",
      },
      {
        type: "FactSet",
        facts: [
          {
            title: "Source",
            value: source,
          },
          {
            title: "Project",
            value: projectName,
          },
          {
            title: "Session",
            value: notification.sessionTitle || notification.sessionId,
          },
          {
            title: "Status",
            value: status,
          },
        ],
      },
    ];

    // Add question text if present
    if (notification.question) {
      bodyElements.push({
        type: "TextBlock",
        text: `**Question:** ${notification.question.length > 500 ? notification.question.slice(0, 497) + "..." : notification.question}`,
        wrap: true,
        spacing: "Medium",
      });
    }

    // Add permission details if present
    if (notification.permissionTitle) {
      bodyElements.push({
        type: "TextBlock",
        text: `**Permission:** ${notification.permissionTitle.length > 500 ? notification.permissionTitle.slice(0, 497) + "..." : notification.permissionTitle}`,
        wrap: true,
        spacing: "Medium",
      });
    }

    if (notification.projectDirectory) {
      bodyElements.push({
        type: "TextBlock",
        text: notification.projectDirectory,
        size: "Small",
        isSubtle: true,
        wrap: true,
      });
    }

    const content: Record<string, unknown> = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body: bodyElements,
    };

    if (hasLink) {
      content.actions = [
        {
          type: "Action.OpenUrl",
          title:
            notification.source === "opencode" || !notification.source
              ? "Open in OpenCode Desktop"
              : "Open session",
          url: notification.desktopUrl,
        },
      ];
    }

    // Adaptive Card format for MS Teams
    const card = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content,
        },
      ],
    };

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MS Teams webhook failed: ${response.status} ${text}`);
    }
  }
}
