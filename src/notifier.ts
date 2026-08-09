/**
 * Notification dispatcher - sends notifications to all enabled providers
 */

import type { NotificationProvider, Notification } from "./providers/index.ts";
import { localHostname } from "./providers/types.ts";
import { normalizeDirectory } from "./config.ts";

/** Drop duplicate notifications for the same session/event within this window. */
export const defaultDedupeWindowMs = 15_000;

export class Notifier {
  private readonly providers: NotificationProvider[];
  private readonly ignoreDirectories: string[];
  private readonly dedupeWindowMs: number;
  /** key -> last send timestamp (ms) */
  private readonly recentSends = new Map<string, number>();

  constructor(
    providers: NotificationProvider[],
    ignoreDirectories: string[] = [],
    dedupeWindowMs: number = defaultDedupeWindowMs
  ) {
    this.providers = providers.filter((p) => p.enabled);
    this.ignoreDirectories = ignoreDirectories.map(normalizeDirectory);
    this.dedupeWindowMs = dedupeWindowMs;

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

    // Stamp origin host once so parent forwarding keeps the child hostname.
    // Ingested payloads from a child already include hostname — do not overwrite.
    if (!notification.hostname) {
      notification.hostname = localHostname();
    }

    // Collapse accidental double-sends (e.g. two child instances, or parallel
    // parent-forward hops) for the same logical event.
    if (this.isDuplicate(notification)) {
      console.log(
        `Notification suppressed (dedupe): type=${notification.type} session=${notification.sessionId}` +
          (notification.hostname ? ` host=${notification.hostname}` : "")
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

  private isDuplicate(notification: Notification): boolean {
    if (this.dedupeWindowMs <= 0) {
      return false;
    }

    const key = dedupeKey(notification);
    const now = Date.now();
    this.pruneRecent(now);

    const last = this.recentSends.get(key);
    if (last !== undefined && now - last < this.dedupeWindowMs) {
      return true;
    }

    this.recentSends.set(key, now);
    return false;
  }

  private pruneRecent(now: number): void {
    for (const [key, ts] of this.recentSends) {
      if (now - ts >= this.dedupeWindowMs) {
        this.recentSends.delete(key);
      }
    }
  }
}

/** Stable key for near-duplicate detection across local SSE and parent ingest. */
export function dedupeKey(notification: Notification): string {
  const source = notification.source ?? "opencode";
  const host = notification.hostname ?? "";
  const base = `${notification.type}:${source}:${notification.sessionId}:${host}`;
  if (notification.type === "permission") {
    return `${base}:${notification.permissionType ?? ""}:${notification.permissionTitle ?? ""}`;
  }
  if (notification.type === "question") {
    return `${base}:${notification.question ?? ""}`;
  }
  return base;
}
