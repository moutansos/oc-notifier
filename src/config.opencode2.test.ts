import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { loadConfig } from "./config.ts";

async function withTempConfig(
  content: unknown,
  fn: (path: string) => Promise<void>
): Promise<void> {
  const path = `/tmp/oc-notifier-test-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(content));
  try {
    await fn(path);
  } finally {
    await unlink(path).catch(() => {});
  }
}

const providers = [{ type: "webhook", enabled: false, url: "http://example.com" }];

const opencodeBlock = {
  baseUrl: "http://127.0.0.1:4096",
  desktopBaseUrl: "https://opencode.example.com",
};

describe("opencode / opencode2 config", () => {
  test("accepts opencode only", async () => {
    await withTempConfig(
      { opencode: opencodeBlock, providers },
      async (path) => {
        const config = await loadConfig(path);
        expect(config.opencode).toEqual(opencodeBlock);
        expect(config.opencode2).toBeUndefined();
      }
    );
  });

  test("accepts opencode2 only", async () => {
    await withTempConfig(
      { opencode2: opencodeBlock, providers },
      async (path) => {
        const config = await loadConfig(path);
        expect(config.opencode).toBeUndefined();
        expect(config.opencode2).toEqual(opencodeBlock);
      }
    );
  });

  test("accepts both opencode and opencode2", async () => {
    const opencode2 = {
      baseUrl: "http://127.0.0.1:4097",
      desktopBaseUrl: "https://opencode2.example.com",
    };
    await withTempConfig(
      { opencode: opencodeBlock, opencode2, providers },
      async (path) => {
        const config = await loadConfig(path);
        expect(config.opencode).toEqual(opencodeBlock);
        expect(config.opencode2).toEqual(opencode2);
      }
    );
  });

  test("accepts neither opencode block when ingest is enabled", async () => {
    await withTempConfig(
      { ingest: { enabled: true }, providers },
      async (path) => {
        const config = await loadConfig(path);
        expect(config.opencode).toBeUndefined();
        expect(config.opencode2).toBeUndefined();
        expect(config.ingest?.enabled).toBe(true);
      }
    );
  });

  test("rejects config with no opencode, opencode2, or ingest", async () => {
    await withTempConfig(
      { providers },
      async (path) => {
        await expect(loadConfig(path)).rejects.toThrow(
          "At least one of opencode, opencode2, or ingest (with enabled: true) must be configured"
        );
      }
    );
  });

  test("reports opencode2 field names in validation errors", async () => {
    await withTempConfig(
      { opencode2: { desktopBaseUrl: "https://opencode2.example.com" }, providers },
      async (path) => {
        await expect(loadConfig(path)).rejects.toThrow("opencode2.baseUrl is required and must be a string");
      }
    );
  });
});
