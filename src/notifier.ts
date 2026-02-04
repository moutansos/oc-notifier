/**
 * Notification dispatcher - sends notifications to all enabled providers
 */

import type { NotificationProvider, Notification } from "./providers/index.ts";

export class Notifier {
  private readonly providers: NotificationProvider[];

  constructor(providers: NotificationProvider[]) {
    this.providers = providers.filter((p) => p.enabled);

    if (this.providers.length === 0) {
      console.warn("No enabled notification providers configured");
    } else {
      console.log(
        `Loaded ${this.providers.length} provider(s): ${this.providers.map((p) => p.type).join(", ")}`
      );
    }
  }

  async send(notification: Notification): Promise<void> {
    const results = await Promise.allSettled(
      this.providers.map(async (provider) => {
        try {
          await provider.send(notification);
          console.log(`Notification sent via ${provider.type}`);
        } catch (error) {
          console.error(`Failed to send notification via ${provider.type}:`, error);
          throw error;
        }
      })
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.error(`${failures.length} provider(s) failed to send notification`);
    }
  }
}
