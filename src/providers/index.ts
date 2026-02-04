/**
 * Provider registry - creates providers from config
 */

import type { ProviderConfig } from "../config.ts";
import type { NotificationProvider } from "./types.ts";
import { DiscordProvider } from "./discord.ts";
import { WebhookProvider } from "./webhook.ts";
import { MSTeamsProvider } from "./msteams.ts";

export type { NotificationProvider, Notification } from "./types.ts";

export function createProvider(config: ProviderConfig): NotificationProvider {
  switch (config.type) {
    case "discord":
      return new DiscordProvider(config);
    case "webhook":
      return new WebhookProvider(config);
    case "msteams":
      return new MSTeamsProvider(config);
    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = config;
      throw new Error(`Unknown provider type: ${(_exhaustive as ProviderConfig).type}`);
  }
}

export function createProviders(configs: ProviderConfig[]): NotificationProvider[] {
  return configs.map(createProvider);
}
