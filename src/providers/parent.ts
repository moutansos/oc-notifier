/**
 * Parent instance notification provider
 *
 * Forwards notifications to another oc-notifier's HTTP ingest API
 * (POST /v1/notify). Used by child instances so webhooks stay centralized
 * on a parent while desktop URLs, project paths, and hostnames remain those
 * of the child.
 */

import type { ParentProviderConfig } from "../config.ts";
import type { Notification, NotificationProvider } from "./types.ts";

/** Default max parent-provider hops before a notification is dropped. */
export const defaultMaxHops = 8;

/** Default HTTP timeout for parent notify requests. */
export const defaultTimeoutMs = 10_000;

export class ParentProvider implements NotificationProvider {
  readonly type = "parent";
  readonly enabled: boolean;
  private readonly notifyUrl: string;
  private readonly token?: string;
  private readonly maxHops: number;
  private readonly timeoutMs: number;

  constructor(config: ParentProviderConfig) {
    this.enabled = config.enabled;
    this.notifyUrl = joinNotifyUrl(config.url);
    this.token = config.token;
    this.maxHops = config.maxHops ?? defaultMaxHops;
    this.timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
  }

  async send(notification: Notification): Promise<void> {
    const hops = notification.hops ?? 0;
    if (hops >= this.maxHops) {
      throw new Error(
        `Parent forward hop limit exceeded (${hops} >= ${this.maxHops}); check for cycles`
      );
    }

    const body: Record<string, unknown> = {
      type: notification.type,
      source: notification.source ?? "opencode",
      sessionId: notification.sessionId,
      sessionTitle: notification.sessionTitle,
      projectId: notification.projectId,
      projectDirectory: notification.projectDirectory,
      desktopUrl: notification.desktopUrl,
      timestamp: notification.timestamp.toISOString(),
      hops: hops + 1,
    };

    if (notification.hostname) {
      body.hostname = notification.hostname;
    }
    if (notification.question) {
      body.question = notification.question;
    }
    if (notification.permissionTitle) {
      body.permissionTitle = notification.permissionTitle;
    }
    if (notification.permissionType) {
      body.permissionType = notification.permissionType;
    }
    if (notification.choices && notification.choices.length > 0) {
      body.choices = notification.choices;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(this.notifyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Parent instance notify failed: ${response.status} ${text}`);
    }
  }
}

/** Build absolute /v1/notify URL from a base or full notify URL. */
export function joinNotifyUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/notify")) {
    return trimmed;
  }
  return `${trimmed}/v1/notify`;
}
