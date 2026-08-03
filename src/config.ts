/**
 * Configuration loading and validation for oc-notifier
 */

export interface OpenCodeConfig {
  baseUrl: string;
  desktopBaseUrl: string;
  username?: string;
  password?: string;
}

/** HTTP ingest API for external sources such as the Claude Code plugin */
export interface IngestConfig {
  enabled: boolean;
  /** Bind address (default: 127.0.0.1) */
  host: string;
  /** Listen port (default: 4100; avoid OpenCode's common 4096/4097) */
  port: number;
  /** Optional bearer token required on ingest requests */
  token?: string;
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
  /**
   * OpenCode SSE monitoring. Optional when ingest is enabled (Claude Code only).
   * When present, connects to OpenCode's global event stream.
   */
  opencode?: OpenCodeConfig;
  /**
   * HTTP ingest server for external clients (Claude Code plugin).
   * Optional when opencode is configured.
   */
  ingest?: IngestConfig;
  providers: ProviderConfig[];
  /** Delay in ms before sending notification after idle (default: 3000). Cancels if session goes busy. */
  debounceMs: number;
  /**
   * Absolute directories whose sessions never produce notifications. A session
   * matches when its project directory is the listed directory or below it.
   * Useful for scratch dirs used by headless probes (e.g. CodexBar's usage
   * probe runs a Claude Code session in /tmp every minute).
   */
  ignoreDirectories: string[];
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

function validateIngestConfig(config: unknown): IngestConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("ingest config must be an object");
  }

  const obj = config as Record<string, unknown>;

  const enabled = obj.enabled === true;

  let host = "127.0.0.1";
  if (obj.host !== undefined) {
    if (typeof obj.host !== "string" || !obj.host) {
      throw new Error("ingest.host must be a non-empty string");
    }
    host = obj.host;
  }

  let port = 4100;
  if (obj.port !== undefined) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      throw new Error("ingest.port must be an integer between 1 and 65535");
    }
    port = obj.port;
  }

  if (obj.token !== undefined && typeof obj.token !== "string") {
    throw new Error("ingest.token must be a string if provided");
  }

  return {
    enabled,
    host,
    port,
    token: obj.token as string | undefined,
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

  const opencode = obj.opencode !== undefined
    ? validateOpenCodeConfig(obj.opencode)
    : undefined;

  const ingest = obj.ingest !== undefined
    ? validateIngestConfig(obj.ingest)
    : undefined;

  const ingestEnabled = ingest?.enabled === true;
  if (!opencode && !ingestEnabled) {
    throw new Error(
      "At least one of opencode or ingest (with enabled: true) must be configured"
    );
  }

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

  // Validate ignoreDirectories (optional, default none)
  let ignoreDirectories: string[] = [];
  if (obj.ignoreDirectories !== undefined) {
    if (!Array.isArray(obj.ignoreDirectories)) {
      throw new Error("ignoreDirectories must be an array of strings");
    }
    ignoreDirectories = obj.ignoreDirectories.map((dir, i) => {
      if (typeof dir !== "string" || !dir) {
        throw new Error(`ignoreDirectories[${i}] must be a non-empty string`);
      }
      return normalizeDirectory(dir);
    });
  }

  return { opencode, ingest, providers, debounceMs, ignoreDirectories };
}

/** Strip trailing slashes so "/tmp/" and "/tmp" compare equal (keeps root "/"). */
export function normalizeDirectory(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed || "/";
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
