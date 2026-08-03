/**
 * Install the bundled Claude Code plugin into ~/.claude/skills/oc-notifier.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin } from "./install-plugin.ts";

const pluginName = "oc-notifier";

export interface InstallClaudePluginOptions {
  sourceDir?: string;
  targetDir?: string;
}

export function defaultPluginSourceDir(): string {
  return resolve(import.meta.dir, "..", "claude-code-plugin");
}

export function defaultPluginTargetDir(): string {
  return join(homedir(), ".claude", "skills", pluginName);
}

export async function installClaudePlugin(
  options: InstallClaudePluginOptions = {}
): Promise<string> {
  return installPlugin({
    label: "Claude Code",
    sourceDir: options.sourceDir ?? defaultPluginSourceDir(),
    targetDir: options.targetDir ?? defaultPluginTargetDir(),
    manifestCandidates: [".claude-plugin/plugin.json"],
  });
}
