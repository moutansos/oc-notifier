/**
 * Microsoft Teams webhook notification provider
 * Uses Adaptive Cards format for rich notifications
 */

import type { MSTeamsProviderConfig } from "../config.ts";
import type { Notification, NotificationProvider } from "./types.ts";

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
    const projectName = notification.projectDirectory.split("/").pop() || notification.projectDirectory;

    // Adaptive Card format for MS Teams
    const card = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              {
                type: "TextBlock",
                size: "Large",
                weight: "Bolder",
                text: "Session Idle",
                style: "heading",
              },
              {
                type: "FactSet",
                facts: [
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
                    value: "Ready for input",
                  },
                ],
              },
              {
                type: "TextBlock",
                text: notification.projectDirectory,
                size: "Small",
                isSubtle: true,
                wrap: true,
              },
            ],
            actions: [
              {
                type: "Action.OpenUrl",
                title: "Open in OpenCode Desktop",
                url: notification.desktopUrl,
              },
            ],
          },
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
