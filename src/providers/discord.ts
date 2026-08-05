/**
 * Discord webhook notification provider
 *
 * Per-message overrides:
 * - username: "{Harness} · {machine}"
 * - avatar_url: harness icon (Claude vs OpenCode)
 */

import { hostname } from "node:os";
import type { DiscordProviderConfig } from "../config.ts";
import type {
  Notification,
  NotificationChoice,
  NotificationProvider,
  NotificationSource,
} from "./types.ts";
import { sourceLabel } from "./types.ts";

/**
 * Public HTTPS icons Discord can fetch (no CORS required — server-side).
 * Prefer PNG favicons; Discord is flaky with SVG for webhook avatars.
 */
const harnessAvatarUrl: Record<NotificationSource, string> = {
  "claude-code": "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
  "grok-code": "https://www.google.com/s2/favicons?domain=grok.com&sz=128",
  codex: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
  opencode: "https://www.google.com/s2/favicons?domain=opencode.ai&sz=128",
};

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

function machineName(): string {
  const raw = hostname();
  // Short hostname (strip domain): "host.local" → "host"
  return raw.split(".")[0] || raw || "unknown";
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
    const projectName =
      notification.projectDirectory.split("/").filter(Boolean).pop() ||
      notification.projectDirectory ||
      "project";
    const source = notification.source ?? "opencode";
    const harness = sourceLabel(source);
    const machine = machineName();
    // Discord author line + embed title: harness and machine
    const identity = `${harness} · ${machine}`;
    const hasLink = Boolean(notification.desktopUrl);

    const isQuestion = notification.type === "question";
    const isPermission = notification.type === "permission";
    const eventLabel = isPermission
      ? "Permission required"
      : isQuestion
        ? "Question pending"
        : "Session idle";
    const status = isPermission
      ? "Waiting for permission"
      : isQuestion
        ? "Waiting for your response"
        : "Ready for input";
    const color = isPermission
      ? 0xed4245
      : isQuestion
        ? 0xffa500
        : 0x5865f2; // Red / orange / blurple

    const fields = [
      {
        name: "Event",
        value: eventLabel,
        inline: true,
      },
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

    const footerText = notification.projectDirectory
      ? notification.projectDirectory
      : identity;

    const embed: Record<string, unknown> = {
      title: identity,
      color,
      fields,
      timestamp: notification.timestamp.toISOString(),
      footer: {
        text: footerText,
      },
    };

    if (hasLink) {
      embed.url = notification.desktopUrl;
    }

    const body: Record<string, unknown> = {
      username: identity,
      avatar_url: harnessAvatarUrl[source],
      embeds: [embed],
    };

    if (hasLink) {
      body.components = [
        {
          type: 1, // Action row
          components: [
            {
              type: 2, // Button
              style: 5, // Link button
              label: source === "opencode"
                ? "Open in OpenCode Desktop"
                : "Open session",
              url: notification.desktopUrl,
            },
          ],
        },
      ];
    }

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
