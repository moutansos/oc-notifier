/**
 * Configuration loading and validation for oc-notifier
 */

export interface OpenCodeConfig {
  baseUrl: string;
  desktopBaseUrl: string;
  username?: string;
  password?: string;
}

export interface DiscordProviderConfig {
  type: "discord";
  enabled: boolean;
  webhookUrl: string;
}

export interface WebhookProviderConfig {
  type: "webhook";
  enabled: boolean;
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
}

export interface MSTeamsProviderConfig {
  type: "msteams";
  enabled: boolean;
  webhookUrl: string;
}

export type ProviderConfig = DiscordProviderConfig | WebhookProviderConfig | MSTeamsProviderConfig;

export interface Config {
  opencode: OpenCodeConfig;
  providers: ProviderConfig[];
  /** Delay in ms before sending notification after idle (default: 3000). Cancels if session goes busy. */
  debounceMs: number;
}

function validateOpenCodeConfig(config: unknown): OpenCodeConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("opencode config must be an object");
  }

  const obj = config as Record<string, unknown>;

  if (typeof obj.baseUrl !== "string" || !obj.baseUrl) {
    throw new Error("opencode.baseUrl is required and must be a string");
  }

  if (typeof obj.desktopBaseUrl !== "string" || !obj.desktopBaseUrl) {
    throw new Error("opencode.desktopBaseUrl is required and must be a string");
  }

  if (obj.username !== undefined && typeof obj.username !== "string") {
    throw new Error("opencode.username must be a string if provided");
  }

  if (obj.password !== undefined && typeof obj.password !== "string") {
    throw new Error("opencode.password must be a string if provided");
  }

  return {
    baseUrl: obj.baseUrl,
    desktopBaseUrl: obj.desktopBaseUrl,
    username: obj.username as string | undefined,
    password: obj.password as string | undefined,
  };
}

function validateDiscordProvider(config: Record<string, unknown>): DiscordProviderConfig {
  if (typeof config.webhookUrl !== "string" || !config.webhookUrl) {
    throw new Error("Discord provider requires webhookUrl");
  }

  return {
    type: "discord",
    enabled: config.enabled === true,
    webhookUrl: config.webhookUrl,
  };
}

function validateWebhookProvider(config: Record<string, unknown>): WebhookProviderConfig {
  if (typeof config.url !== "string" || !config.url) {
    throw new Error("Webhook provider requires url");
  }

  const method = config.method ?? "POST";
  if (method !== "GET" && method !== "POST" && method !== "PUT") {
    throw new Error("Webhook provider method must be GET, POST, or PUT");
  }

  let headers: Record<string, string> | undefined;
  if (config.headers !== undefined) {
    if (typeof config.headers !== "object" || config.headers === null) {
      throw new Error("Webhook provider headers must be an object");
    }
    headers = config.headers as Record<string, string>;
  }

  return {
    type: "webhook",
    enabled: config.enabled === true,
    url: config.url,
    method,
    headers,
  };
}

function validateMSTeamsProvider(config: Record<string, unknown>): MSTeamsProviderConfig {
  if (typeof config.webhookUrl !== "string" || !config.webhookUrl) {
    throw new Error("MS Teams provider requires webhookUrl");
  }

  return {
    type: "msteams",
    enabled: config.enabled === true,
    webhookUrl: config.webhookUrl,
  };
}

function validateProviderConfig(config: unknown, index: number): ProviderConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error(`Provider at index ${index} must be an object`);
  }

  const obj = config as Record<string, unknown>;

  if (typeof obj.type !== "string") {
    throw new Error(`Provider at index ${index} must have a type`);
  }

  switch (obj.type) {
    case "discord":
      return validateDiscordProvider(obj);
    case "webhook":
      return validateWebhookProvider(obj);
    case "msteams":
      return validateMSTeamsProvider(obj);
    default:
      throw new Error(`Unknown provider type: ${obj.type}`);
  }
}

function validateConfig(config: unknown): Config {
  if (typeof config !== "object" || config === null) {
    throw new Error("Config must be an object");
  }

  const obj = config as Record<string, unknown>;

  const opencode = validateOpenCodeConfig(obj.opencode);

  if (!Array.isArray(obj.providers)) {
    throw new Error("providers must be an array");
  }

  const providers = obj.providers.map((p, i) => validateProviderConfig(p, i));

  // Validate debounceMs (optional, default 3000ms)
  let debounceMs = 3000;
  if (obj.debounceMs !== undefined) {
    if (typeof obj.debounceMs !== "number" || obj.debounceMs < 0) {
      throw new Error("debounceMs must be a non-negative number");
    }
    debounceMs = obj.debounceMs;
  }

  return { opencode, providers, debounceMs };
}

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }

  const content = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse config file as JSON: ${path}`);
  }

  return validateConfig(parsed);
}
