/**
 * Notification dispatcher - sends notifications to all enabled providers
 */

import type { NotificationProvider, Notification } from "./providers/index.ts";
import { normalizeDirectory } from "./config.ts";

export class Notifier {
  private readonly providers: NotificationProvider[];
  private readonly ignoreDirectories: string[];

  constructor(providers: NotificationProvider[], ignoreDirectories: string[] = []) {
    this.providers = providers.filter((p) => p.enabled);
    this.ignoreDirectories = ignoreDirectories.map(normalizeDirectory);

    if (this.providers.length === 0) {
      console.warn("No enabled notification providers configured");
    } else {
      console.log(
        `Loaded ${this.providers.length} provider(s): ${this.providers.map((p) => p.type).join(", ")}`
      );
    }

    if (this.ignoreDirectories.length > 0) {
      console.log(`Ignoring sessions under: ${this.ignoreDirectories.join(", ")}`);
    }
  }

  async send(notification: Notification): Promise<void> {
    const ignoredBy = this.matchIgnoredDirectory(notification.projectDirectory);
    if (ignoredBy) {
      console.log(
        `Notification suppressed: session ${notification.sessionId} is under ignored directory ${ignoredBy}`
      );
      return;
    }

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

  /** The configured directory this session sits in or under, if any. */
  private matchIgnoredDirectory(projectDirectory: string): string | null {
    if (!projectDirectory || this.ignoreDirectories.length === 0) {
      return null;
    }

    const directory = normalizeDirectory(projectDirectory);
    for (const ignored of this.ignoreDirectories) {
      const prefix = ignored === "/" ? "/" : `${ignored}/`;
      if (directory === ignored || directory.startsWith(prefix)) {
        return ignored;
      }
    }

    return null;
  }
}
