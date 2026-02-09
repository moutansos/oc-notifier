/**
 * Discord webhook notification provider
 */

import type { DiscordProviderConfig } from "../config.ts";
import type { Notification, NotificationProvider } from "./types.ts";

export class DiscordProvider implements NotificationProvider {
  readonly type = "discord";
  readonly enabled: boolean;
  private readonly webhookUrl: string;

  constructor(config: DiscordProviderConfig) {
    this.enabled = config.enabled;
    this.webhookUrl = config.webhookUrl;
  }

  async send(notification: Notification): Promise<void> {
    // Extract just the project folder name from the full path
    const projectName = notification.projectDirectory.split("/").pop() || notification.projectDirectory;

    const isQuestion = notification.type === "question";
    const title = isQuestion
      ? `Question Pending: ${projectName}`
      : `Session Idle: ${projectName}`;
    const status = isQuestion ? "Waiting for your response" : "Ready for input";
    const color = isQuestion ? 0xffa500 : 0x5865f2; // Orange for question, blurple for idle

    const fields = [
      {
        name: "Project",
        value: projectName,
        inline: true,
      },
      {
        name: "Session",
        value: notification.sessionTitle || notification.sessionId,
        inline: true,
      },
      {
        name: "Status",
        value: status,
        inline: true,
      },
    ];

    // Add question text if present
    if (notification.question) {
      fields.push({
        name: "Question",
        value: notification.question.length > 1024
          ? notification.question.slice(0, 1021) + "..."
          : notification.question,
        inline: false,
      });
    }

    const embed = {
      title,
      color,
      fields,
      url: notification.desktopUrl,
      timestamp: notification.timestamp.toISOString(),
      footer: {
        text: `OpenCode | ${notification.projectDirectory}`,
      },
    };

    const body = {
      embeds: [embed],
      components: [
        {
          type: 1, // Action row
          components: [
            {
              type: 2, // Button
              style: 5, // Link button
              label: "Open in OpenCode Desktop",
              url: notification.desktopUrl,
            },
          ],
        },
      ],
    };

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} ${text}`);
    }
  }
}
