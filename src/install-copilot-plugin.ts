/**
 * Install the Copilot CLI integration:
 * 1. Install scripts to ~/.copilot/hooks/oc-notifier (symlink/copy)
 * 2. Write ~/.copilot/hooks/oc-notifier.json with absolute bash paths
 *
 * Copilot CLI loads user-level hooks from ~/.copilot/hooks/*.json
 * (or $COPILOT_HOME/hooks/). Each file needs "version": 1.
 *
 * @see https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin } from "./install-plugin.ts";

const pluginName = "oc-notifier";
const forwardRel = "scripts/forward.sh";

export interface InstallCopilotPluginOptions {
  sourceDir?: string;
  targetDir?: string;
  hooksJsonPath?: string;
}

export function defaultCopilotPluginSourceDir(): string {
  return resolve(import.meta.dir, "..", "copilot-plugin");
}

export function defaultCopilotPluginTargetDir(): string {
  const copilotHome = process.env.COPILOT_HOME?.trim();
  if (copilotHome) {
    return join(copilotHome, "hooks", pluginName);
  }
  return join(homedir(), ".copilot", "hooks", pluginName);
}

export function defaultCopilotHooksJsonPath(): string {
  const copilotHome = process.env.COPILOT_HOME?.trim();
  if (copilotHome) {
    return join(copilotHome, "hooks", `${pluginName}.json`);
  }
  return join(homedir(), ".copilot", "hooks", `${pluginName}.json`);
}

export async function installCopilotPlugin(
  options: InstallCopilotPluginOptions = {}
): Promise<string> {
  const sourceDir = options.sourceDir ?? defaultCopilotPluginSourceDir();
  const targetDir = options.targetDir ?? defaultCopilotPluginTargetDir();
  // When --plugin-target is customized, place oc-notifier.json next to the
  // install dir (…/hooks/oc-notifier → …/hooks/oc-notifier.json) so dry-runs
  // and alternate roots do not rewrite ~/.copilot by accident.
  const hooksJsonPath =
    options.hooksJsonPath ??
    (options.targetDir
      ? join(resolve(options.targetDir), "..", `${pluginName}.json`)
      : defaultCopilotHooksJsonPath());

  const installSummary = await installPlugin({
    label: "Copilot CLI",
    sourceDir,
    targetDir,
    manifestCandidates: [
      "hooks/hooks.json",
      "scripts/forward.sh",
    ],
  });

  const forwardPath = resolve(targetDir, forwardRel);

  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(forwardPath, 0o755);
  } catch {
    // best-effort
  }

  const hooksSummary = await writeCopilotHooksJson(hooksJsonPath, forwardPath);

  return `${installSummary}\n${hooksSummary}`;
}

interface CopilotHookEntry {
  type?: string;
  bash?: string;
  powershell?: string;
  command?: string;
  matcher?: string;
  timeoutSec?: number;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface CopilotHooksFile {
  version?: number;
  disableAllHooks?: boolean;
  hooks?: Record<string, CopilotHookEntry[]>;
  [key: string]: unknown;
}

async function writeCopilotHooksJson(
  hooksJsonPath: string,
  forwardPath: string
): Promise<string> {
  // Absolute bash invocation so the script runs even when not +x.
  // Set both bash and powershell explicitly: when `bash` is present, Copilot
  // does not copy `command` into powershell — Windows needs its own entry.
  // Both invoke the same bash script (Git Bash / WSL bash on Windows).
  const bashCommand = `bash ${shellQuote(forwardPath)}`;

  const ourEntry = (matcher?: string): CopilotHookEntry => {
    const entry: CopilotHookEntry = {
      type: "command",
      bash: bashCommand,
      powershell: bashCommand,
      timeoutSec: 15,
    };
    if (matcher) {
      entry.matcher = matcher;
    }
    return entry;
  };

  // Always rewrite our owned file (oc-notifier.json) so upgrades replace paths.
  // Do not merge into other user hook files.
  //
  // We hook notification (permission_prompt | elicitation_dialog) rather than
  // permissionRequest: the latter fires *before* auto-allow rules and would
  // spam for tools that never show a UI.
  const next: CopilotHooksFile = {
    version: 1,
    hooks: {
      agentStop: [ourEntry()],
      notification: [ourEntry("permission_prompt|elicitation_dialog")],
    },
  };

  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(hooksJsonPath, ".."), { recursive: true });

  await Bun.write(hooksJsonPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated Copilot CLI hooks: ${hooksJsonPath}`);
  console.log(
    `  agentStop + notification(permission_prompt|elicitation_dialog) → ${forwardPath}`
  );
  console.log("  Restart Copilot CLI to load hook changes.");

  return `Registered agentStop and notification hooks in ${hooksJsonPath}`;
}

/** Minimal shell quoting for absolute paths (spaces / specials). */
function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(path)) {
    return path;
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
