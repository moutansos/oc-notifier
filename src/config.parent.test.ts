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

describe("parent provider config", () => {
  test("accepts a parent provider entry", async () => {
    await withTempConfig(
      {
        ingest: { enabled: true, port: 4100 },
        providers: [
          {
            type: "parent",
            enabled: true,
            url: "http://central:4100",
            token: "secret",
            maxHops: 4,
            timeoutMs: 5000,
          },
        ],
      },
      async (path) => {
        const config = await loadConfig(path);
        expect(config.providers).toHaveLength(1);
        expect(config.providers[0]).toEqual({
          type: "parent",
          enabled: true,
          url: "http://central:4100",
          token: "secret",
          maxHops: 4,
          timeoutMs: 5000,
        });
      }
    );
  });

  test("requires url for parent provider", async () => {
    await withTempConfig(
      {
        ingest: { enabled: true },
        providers: [{ type: "parent", enabled: true }],
      },
      async (path) => {
        await expect(loadConfig(path)).rejects.toThrow("Parent provider requires url");
      }
    );
  });

  test("rejects whitespace-only url", async () => {
    await withTempConfig(
      {
        ingest: { enabled: true },
        providers: [{ type: "parent", enabled: true, url: "   " }],
      },
      async (path) => {
        await expect(loadConfig(path)).rejects.toThrow("Parent provider requires url");
      }
    );
  });
});
