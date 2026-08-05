/**
 * Install the Codex CLI integration:
 * 1. Install plugin tree to ~/.codex/hooks/oc-notifier (symlink/copy)
 * 2. Merge Stop + PermissionRequest into ~/.codex/hooks.json with absolute paths
 *
 * Codex discovers user hooks from ~/.codex/hooks.json (and plugin bundles).
 * We always write absolute command paths so hooks work regardless of cwd.
 *
 * Note: rewriting hooks.json may change formatting/key order. Codex trusts hooks
 * against a definition hash, so re-install can require re-trusting hooks in /hooks.
 */

import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin } from "./install-plugin.ts";

const pluginName = "oc-notifier";
const forwardRel = "scripts/forward.sh";
/** statusMessage stamped on handlers we own — stable identity across retargets */
const ourStatusMessage = "oc-notifier";
/** Legacy path markers for installs before statusMessage identity */
const legacyCommandMarkers = [
  "hooks/oc-notifier/scripts/forward.sh",
  "oc-notifier/scripts/forward.sh",
];

export interface InstallCodexPluginOptions {
  sourceDir?: string;
  targetDir?: string;
  hooksJsonPath?: string;
}

export function defaultCodexPluginSourceDir(): string {
  return resolve(import.meta.dir, "..", "codex-plugin");
}

export function defaultCodexPluginTargetDir(): string {
  return join(homedir(), ".codex", "hooks", pluginName);
}

export function defaultCodexHooksJsonPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

export async function installCodexPlugin(
  options: InstallCodexPluginOptions = {}
): Promise<string> {
  const sourceDir = options.sourceDir ?? defaultCodexPluginSourceDir();
  const targetDir = options.targetDir ?? defaultCodexPluginTargetDir();
  const hooksJsonPath = options.hooksJsonPath ?? defaultCodexHooksJsonPath();

  const installSummary = await installPlugin({
    label: "Codex",
    sourceDir,
    targetDir,
    manifestCandidates: [
      ".codex-plugin/plugin.json",
      "hooks/hooks.json",
      "scripts/forward.sh",
    ],
  });

  const forwardPath = resolve(targetDir, forwardRel);

  // Ensure the forward script is executable even when copied on Windows-ish FS
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(forwardPath, 0o755);
  } catch {
    // best-effort
  }

  const hooksSummary = await mergeCodexHooksJson(hooksJsonPath, forwardPath);

  return `${installSummary}\n${hooksSummary}`;
}

interface CodexHookHandler {
  type?: string;
  command?: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
}

interface CodexMatcherGroup {
  matcher?: string;
  hooks?: CodexHookHandler[];
  [key: string]: unknown;
}

interface CodexHooksFile {
  description?: string;
  hooks?: Record<string, CodexMatcherGroup[]>;
  [key: string]: unknown;
}

async function mergeCodexHooksJson(
  hooksJsonPath: string,
  forwardPath: string
): Promise<string> {
  let existing: CodexHooksFile = {};
  const file = Bun.file(hooksJsonPath);

  if (await file.exists()) {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        existing = parsed as CodexHooksFile;
      }
    } catch {
      throw new Error(
        `Failed to parse existing Codex hooks file as JSON: ${hooksJsonPath}\n` +
          `Fix or move it, then re-run --install-codex-plugin.`
      );
    }
  }

  if (existing.hooks !== undefined && (typeof existing.hooks !== "object" || existing.hooks === null || Array.isArray(existing.hooks))) {
    throw new Error(
      `Invalid Codex hooks file shape: ${hooksJsonPath}\n` +
        `Expected "hooks" to be an object of event name → matcher groups.`
    );
  }

  const hooks = { ...(existing.hooks ?? {}) };
  const ourHandler: CodexHookHandler = {
    type: "command",
    command: forwardPath,
    timeout: 15,
    statusMessage: ourStatusMessage,
  };

  // On Windows, prefer bash-invoked script so shebang-less shells still work
  // when Git Bash / WSL bash is on PATH. Native PowerShell still needs bash.
  if (platform() === "win32") {
    ourHandler.commandWindows = `bash "${forwardPath.replace(/\\/g, "/")}"`;
  }

  hooks.Stop = upsertOurGroup("Stop", hooks.Stop, ourHandler, forwardPath);
  hooks.PermissionRequest = upsertOurGroup(
    "PermissionRequest",
    hooks.PermissionRequest,
    ourHandler,
    forwardPath
  );

  const next: CodexHooksFile = {
    ...existing,
    hooks,
  };

  // Ensure parent dir exists (installPlugin already did for target, but hooks.json may be missing)
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(hooksJsonPath, ".."), { recursive: true });

  await Bun.write(hooksJsonPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated Codex hooks: ${hooksJsonPath}`);
  console.log(`  Stop + PermissionRequest → ${forwardPath}`);
  console.log(
    "  Note: Codex may ask you to re-trust hooks after install (definition hash changes)."
  );

  return `Registered Stop and PermissionRequest in ${hooksJsonPath}`;
}

/**
 * Keep other users' matcher groups; strip any handler we own (by statusMessage,
 * exact forward path, or legacy path markers) and append a clean group.
 */
function upsertOurGroup(
  eventName: string,
  groups: CodexMatcherGroup[] | undefined,
  ourHandler: CodexHookHandler,
  forwardPath: string
): CodexMatcherGroup[] {
  if (groups !== undefined && !Array.isArray(groups)) {
    throw new Error(
      `Invalid Codex hooks shape for "${eventName}": expected an array of matcher groups`
    );
  }

  const result: CodexMatcherGroup[] = [];

  for (const group of groups ?? []) {
    const existingHandlers = Array.isArray(group.hooks) ? group.hooks : [];
    const handlers = existingHandlers.filter((h) => !isOurHandler(h, forwardPath));
    // Drop empty groups that only held our old entry
    if (handlers.length === 0 && existingHandlers.length > 0) {
      continue;
    }
    if (handlers.length !== existingHandlers.length) {
      result.push({ ...group, hooks: handlers });
    } else {
      result.push(group);
    }
  }

  result.push({ hooks: [ourHandler] });
  return result;
}

function isOurHandler(handler: CodexHookHandler, forwardPath: string): boolean {
  if (handler.statusMessage === ourStatusMessage) {
    return true;
  }

  const command = typeof handler.command === "string" ? handler.command : "";
  if (!command) {
    return false;
  }

  if (resolve(command) === resolve(forwardPath)) {
    return true;
  }

  // Exact absolute path match even when not yet resolved identically
  if (command === forwardPath) {
    return true;
  }

  for (const marker of legacyCommandMarkers) {
    if (command.includes(marker)) {
      return true;
    }
  }

  // Any prior install of this forward script under an alternate --plugin-target
  // (…/scripts/forward.sh with oc-notifier status already covered above).
  if (command.endsWith(`/${forwardRel}`) || command.endsWith(`\\${forwardRel.replace(/\//g, "\\")}`)) {
    // Only claim it if statusMessage is missing (legacy) or already ours;
    // don't steal another project's script coincidentally named the same.
    if (handler.statusMessage === undefined || handler.statusMessage === ourStatusMessage) {
      return true;
    }
  }

  return false;
}
