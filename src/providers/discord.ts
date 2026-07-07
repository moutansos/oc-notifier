/**
 * Discord webhook notification provider
 */

import type { DiscordProviderConfig } from "../config.ts";
import type { Notification, NotificationChoice, NotificationProvider } from "./types.ts";

function truncateField(value: string, maxLength = 1024): string {
  return value.length > maxLength ? value.slice(0, maxLength - 3) + "..." : value;
}

function formatChoices(choices: NotificationChoice[]): string {
  return choices
    .map((choice) => {
      const description = choice.description ? ` — ${choice.description}` : "";
      return `• **${choice.label}**${description}`;
    })
    .join("\n");
}

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
    const isPermission = notification.type === "permission";
    const title = isPermission
      ? `Permission Required: ${projectName}`
      : isQuestion
        ? `Question Pending: ${projectName}`
        : `Session Idle: ${projectName}`;
    const status = isPermission
      ? "Waiting for permission"
      : isQuestion ? "Waiting for your response" : "Ready for input";
    const color = isPermission ? 0xed4245 : isQuestion ? 0xffa500 : 0x5865f2; // Red for permission, orange for question, blurple for idle

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
        value: truncateField(notification.question),
        inline: false,
      });
    }

    // Add permission details if present
    if (notification.permissionTitle) {
      fields.push({
        name: "Permission",
        value: truncateField(notification.permissionTitle),
        inline: false,
      });
    }

    if (notification.choices && notification.choices.length > 0) {
      fields.push({
        name: isPermission ? "Approval Options" : "Options",
        value: truncateField(formatChoices(notification.choices)),
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
