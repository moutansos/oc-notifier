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

    const embed = {
      title: "Session Idle",
      color: 0x5865f2, // Discord blurple
      fields: [
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
          value: "Ready for input",
          inline: true,
        },
      ],
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
