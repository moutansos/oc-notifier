/**
 * Shared install helper for harness plugins (Claude Code / Grok / Codex).
 *
 * - Linux / macOS: symlink (stays in sync with the repo)
 * - Windows: recursive copy
 * Re-running is safe: existing installs are replaced for seamless upgrades.
 */

import { cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface InstallPluginOptions {
  /** Human label used in log messages, e.g. "Claude Code" or "Grok Code" */
  label: string;
  /** Absolute path to the plugin source directory in this repo */
  sourceDir: string;
  /** Absolute install target path */
  targetDir: string;
  /**
   * Relative paths (from sourceDir) of acceptable manifests.
   * Install succeeds if any one exists.
   */
  manifestCandidates: string[];
}

/**
 * Install a plugin directory to targetDir via symlink (unix) or copy (Windows).
 * Returns a short human-readable summary.
 */
export async function installPlugin(options: InstallPluginOptions): Promise<string> {
  const sourceDir = resolve(options.sourceDir);
  const targetDir = resolve(options.targetDir);
  const isWindows = platform() === "win32";
  const { label, manifestCandidates } = options;

  let foundManifest = false;
  for (const rel of manifestCandidates) {
    if (await Bun.file(join(sourceDir, rel)).exists()) {
      foundManifest = true;
      break;
    }
  }

  if (!foundManifest) {
    throw new Error(
      `${label} plugin not found at ${sourceDir}\n` +
        `Expected one of: ${manifestCandidates.join(", ")}. ` +
        `Run from the oc-notifier repo, or pass --plugin-source.`
    );
  }

  await mkdir(join(targetDir, ".."), { recursive: true });

  if (isWindows) {
    return installByCopy(label, sourceDir, targetDir);
  }

  return installBySymlink(label, sourceDir, targetDir);
}

async function installBySymlink(
  label: string,
  sourceDir: string,
  targetDir: string
): Promise<string> {
  const existing = await pathInfo(targetDir);

  if (existing?.kind === "symlink") {
    const link = await readlink(targetDir);
    const current = isAbsolute(link) ? resolve(link) : resolve(dirname(targetDir), link);
    if (current === sourceDir) {
      console.log(`Plugin already installed (symlink): ${targetDir}`);
      console.log(`  -> ${sourceDir}`);
      return `${label} plugin already up to date at ${targetDir}`;
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
    ? `Updated ${label} plugin symlink at ${targetDir}`
    : `Symlinked ${label} plugin to ${targetDir}`;
}

async function installByCopy(
  label: string,
  sourceDir: string,
  targetDir: string
): Promise<string> {
  const existing = await pathInfo(targetDir);

  if (existing) {
    console.log(`Updating existing ${existing.kind}: ${targetDir}`);
    await rm(targetDir, { recursive: true, force: true });
  } else {
    console.log(`Copying plugin to ${targetDir} (Windows)...`);
  }

  await cp(sourceDir, targetDir, { recursive: true, force: true });
  return existing
    ? `Updated ${label} plugin at ${targetDir}`
    : `Copied ${label} plugin to ${targetDir}`;
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
