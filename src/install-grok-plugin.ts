/**
 * Install the bundled Grok plugin into ~/.grok/plugins/oc-notifier (auto-trusted).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin } from "./install-plugin.ts";

const pluginName = "oc-notifier";

export interface InstallGrokPluginOptions {
  sourceDir?: string;
  targetDir?: string;
}

export function defaultGrokPluginSourceDir(): string {
  return resolve(import.meta.dir, "..", "grok-code-plugin");
}

export function defaultGrokPluginTargetDir(): string {
  return join(homedir(), ".grok", "plugins", pluginName);
}

export async function installGrokPlugin(
  options: InstallGrokPluginOptions = {}
): Promise<string> {
  return installPlugin({
    label: "Grok Code",
    sourceDir: options.sourceDir ?? defaultGrokPluginSourceDir(),
    targetDir: options.targetDir ?? defaultGrokPluginTargetDir(),
    manifestCandidates: ["plugin.json", ".claude-plugin/plugin.json"],
  });
}
