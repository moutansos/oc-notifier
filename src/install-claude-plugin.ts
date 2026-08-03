/**
 * Install the bundled Claude Code plugin into the user's Claude skills directory.
 *
 * - Linux / macOS: symlink the plugin directory (stays in sync with the repo)
 * - Windows: recursive copy (symlinks often need elevated privileges)
 *
 * Re-running is safe: existing installs are replaced so upgrades are seamless.
 */

import { cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PLUGIN_NAME = "oc-notifier";

export interface InstallClaudePluginOptions {
  /** Override source plugin directory (default: <repo>/claude-code-plugin) */
  sourceDir?: string;
  /** Override install target (default: ~/.claude/skills/oc-notifier) */
  targetDir?: string;
}

export function defaultPluginSourceDir(): string {
  // src/install-claude-plugin.ts → ../claude-code-plugin
  return resolve(import.meta.dir, "..", "claude-code-plugin");
}

export function defaultPluginTargetDir(): string {
  return join(homedir(), ".claude", "skills", PLUGIN_NAME);
}

/**
 * Install the Claude Code plugin.
 * Returns a short human-readable summary of what was done.
 */
export async function installClaudePlugin(
  options: InstallClaudePluginOptions = {}
): Promise<string> {
  const sourceDir = resolve(options.sourceDir ?? defaultPluginSourceDir());
  const targetDir = resolve(options.targetDir ?? defaultPluginTargetDir());
  const isWindows = platform() === "win32";

  const sourceManifest = Bun.file(join(sourceDir, ".claude-plugin", "plugin.json"));
  if (!(await sourceManifest.exists())) {
    throw new Error(
      `Claude Code plugin not found at ${sourceDir}\n` +
        `Expected .claude-plugin/plugin.json. Run from the oc-notifier repo, or pass --plugin-source.`
    );
  }

  const parentDir = join(targetDir, "..");
  await mkdir(parentDir, { recursive: true });

  if (isWindows) {
    return installByCopy(sourceDir, targetDir);
  }

  return installBySymlink(sourceDir, targetDir);
}

async function installBySymlink(sourceDir: string, targetDir: string): Promise<string> {
  const existing = await pathInfo(targetDir);

  // Already the correct symlink — nothing to do (symlink tracks source upgrades)
  if (existing?.kind === "symlink") {
    const link = await readlink(targetDir);
    const current = isAbsolute(link) ? resolve(link) : resolve(dirname(targetDir), link);
    if (current === sourceDir) {
      console.log(`Plugin already installed (symlink): ${targetDir}`);
      console.log(`  -> ${sourceDir}`);
      return `Claude Code plugin already up to date at ${targetDir}`;
    }
    console.log(`Updating symlink (was -> ${current})`);
  } else if (existing) {
    console.log(`Replacing existing ${existing.kind}: ${targetDir}`);
  }

  if (existing) {
    await rm(targetDir, { recursive: true, force: true });
  }

  console.log(`Symlinking plugin to ${targetDir}...`);
  console.log(`  ${targetDir} -> ${sourceDir}`);
  await symlink(sourceDir, targetDir, "dir");
  return existing
    ? `Updated Claude Code plugin symlink at ${targetDir}`
    : `Symlinked Claude Code plugin to ${targetDir}`;
}

async function installByCopy(sourceDir: string, targetDir: string): Promise<string> {
  const existing = await pathInfo(targetDir);

  if (existing) {
    console.log(`Updating existing ${existing.kind}: ${targetDir}`);
    await rm(targetDir, { recursive: true, force: true });
  } else {
    console.log(`Copying plugin to ${targetDir} (Windows)...`);
  }

  await cp(sourceDir, targetDir, { recursive: true, force: true });
  return existing
    ? `Updated Claude Code plugin at ${targetDir}`
    : `Copied Claude Code plugin to ${targetDir}`;
}

type PathKind = "symlink" | "directory" | "file";

async function pathInfo(path: string): Promise<{ kind: PathKind } | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return { kind: "symlink" };
    if (stats.isDirectory()) return { kind: "directory" };
    return { kind: "file" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }
}
