import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isProbablyTextFile, isDirectory, readText, relativePath } from "../lib/files.js";

const SNAPSHOT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".tmp",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".plugin-eval",
]);

const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 10000;
const MAX_SNAPSHOT_ENTRIES = 20000;

export class BenchmarkResourceLimitError extends Error {
  constructor(resource, limit, observed, unit = "bytes") {
    super(`Benchmark ${resource} exceeded the ${limit} ${unit} limit.`);
    this.name = "BenchmarkResourceLimitError";
    this.resource = resource;
    this.limit = limit;
    this.observed = observed;
    this.unit = unit;
  }
}

function testFilePattern(filePath) {
  return /(^|\/)(tests?|__tests__)\/|(\.test|\.spec)\.|(^|\/)test_[^/]+\.py$/.test(filePath);
}

function fileParts(relativeFile) {
  if (typeof relativeFile !== "string" || !relativeFile || relativeFile.includes("\0") ||
    path.posix.isAbsolute(relativeFile) || path.win32.isAbsolute(relativeFile)) {
    throw new Error("Benchmark includes must be exact relative file paths.");
  }
  const parts = relativeFile.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("Benchmark includes must be exact relative file paths.");
  }
  return parts;
}

async function assertNoSymlinkAncestors(sourcePath) {
  const resolved = path.resolve(sourcePath);
  let current = path.parse(resolved).root;
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new Error("Benchmark source paths must not contain symbolic links.");
    }
  }
}

export function normalizeBenchmarkFilePath(relativeFile) {
  return fileParts(relativeFile).join("/");
}

async function copySelectedFiles(sourcePath, destinationPath, includes) {
  if (!Array.isArray(includes)) throw new Error("Benchmark includes must be a file list.");
  await assertNoSymlinkAncestors(sourcePath);
  await fs.mkdir(destinationPath, { recursive: true });
  const realRoot = await fs.realpath(sourcePath);
  for (const relativeFile of new Set(includes)) {
    const parts = fileParts(relativeFile);
    let current = sourcePath;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error("Benchmark includes must name regular files without symbolic links.");
      }
    }
    const realFile = await fs.realpath(current);
    const relativeRealFile = path.relative(realRoot, realFile);
    if (relativeRealFile === ".." || relativeRealFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRealFile)) {
      throw new Error("Benchmark include escapes its source directory.");
    }
    const destination = path.join(destinationPath, ...parts);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(current, destination);
  }
}

async function copyIfExists(sourcePath, destinationPath) {
  try {
    const stat = await fs.lstat(sourcePath);
    if (!stat.isFile()) throw new Error("Scoped Codex home files must be regular files, not symbolic links.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return true;
}

async function createWorkspaceCopy(sourcePath, workspacePath, includes) {
  await copySelectedFiles(sourcePath, workspacePath, includes);
  return {
    workspacePath,
    cleanup: async () => {
      await fs.rm(workspacePath, { recursive: true, force: true });
    },
  };
}

async function provisionSkillInstall(target, codexHomePath, targetIncludes) {
  const skillPath = path.join(codexHomePath, "skills", target.name);
  await copySelectedFiles(target.path, skillPath, ["SKILL.md", ...targetIncludes]);
  return skillPath;
}

async function provisionPluginInstall(target, workspacePath, targetIncludes) {
  const pluginsRoot = path.join(workspacePath, "plugins");
  const installPath = path.join(pluginsRoot, target.name);
  await copySelectedFiles(target.path, installPath, [".codex-plugin/plugin.json", ...targetIncludes]);

  const marketplacePath = path.join(workspacePath, ".agents", "plugins", "marketplace.json");
  const marketplace = {
    name: "plugin-eval-benchmark",
    interface: {
      displayName: "Plugin Eval Benchmark",
    },
    plugins: [
      {
        name: target.name,
        source: {
          source: "local",
          path: `./plugins/${target.name}`,
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Developer Tools",
      },
    ],
  };

  await fs.mkdir(path.dirname(marketplacePath), { recursive: true });
  await fs.writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  return installPath;
}

async function seedCodexHome(codexHomePath) {
  const explicitSourceCodexHome = process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE
    ? path.resolve(process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE)
    : null;
  if (explicitSourceCodexHome) await assertNoSymlinkAncestors(explicitSourceCodexHome);

  await fs.mkdir(codexHomePath, { recursive: true });
  const copied = await Promise.all([
    explicitSourceCodexHome
      ? copyIfExists(path.join(explicitSourceCodexHome, "auth.json"), path.join(codexHomePath, "auth.json"))
      : Promise.resolve(false),
    explicitSourceCodexHome
      ? copyIfExists(path.join(explicitSourceCodexHome, "config.toml"), path.join(codexHomePath, "config.toml"))
      : Promise.resolve(false),
  ]);
  return copied.some(Boolean);
}

export function defaultTargetProvisioningMode(target) {
  if (target.kind === "skill") {
    return "isolated-skill-home";
  }
  if (target.kind === "plugin") {
    return "workspace-plugin-marketplace";
  }
  throw new Error("Benchmarking only supports Codex skills and plugins.");
}

export async function provisionBenchmarkWorkspace({ target, config, scenarioId, workspaceIncludes = [], targetIncludes = [] }) {
  const sourcePath = path.resolve(config.workspace.sourcePath);
  if (!(await isDirectory(sourcePath))) {
    throw new Error(`Benchmark workspace.sourcePath must be a directory: ${sourcePath}`);
  }

  const setupMode = config.workspace.setupMode || "copy";
  if (setupMode !== "copy") throw new Error("Benchmark workspace setupMode must be copy; git-worktree is disabled.");
  if (target.kind === "plugin" && targetIncludes.length === 0) {
    throw new Error("Plugin benchmarks require explicit --target-include entries for the plugin files to evaluate.");
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `plugin-eval-${scenarioId}-`));
  const workspacePath = path.join(tempRoot, "workspace");
  const homePath = path.join(tempRoot, "home");
  const codexHomePath = path.join(homePath, ".codex");
  let workspace;
  try {
    const sensitiveHomeSeeded = await seedCodexHome(codexHomePath);
    workspace = await createWorkspaceCopy(sourcePath, workspacePath, workspaceIncludes);

    let installedTargetPath = null;
    if (config.targetProvisioning.mode === "isolated-skill-home") {
      installedTargetPath = await provisionSkillInstall(target, codexHomePath, targetIncludes);
    } else if (config.targetProvisioning.mode === "workspace-plugin-marketplace") {
      installedTargetPath = await provisionPluginInstall(target, workspacePath, targetIncludes);
    } else {
      throw new Error(`Unsupported target provisioning mode: ${config.targetProvisioning.mode}`);
    }

    return {
    tempRoot,
    workspacePath,
    homePath,
    codexHomePath,
    installedTargetPath,
    setupMode,
    sensitiveHomeSeeded,
      cleanupSensitiveHome: async () => fs.rm(homePath, { recursive: true, force: true }),
      cleanup: async () => {
        try {
          await workspace.cleanup();
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      if (workspace) await workspace.cleanup();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function inspectSnapshotFile(filePath, isText) {
  const hash = createHash("sha1");
  let bytes = 0;
  let lineCount = 1;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > MAX_SNAPSHOT_FILE_BYTES) {
      throw new BenchmarkResourceLimitError("workspace snapshot file", MAX_SNAPSHOT_FILE_BYTES, bytes);
    }
    hash.update(chunk);
    if (isText) {
      for (const byte of chunk) if (byte === 10) lineCount += 1;
    }
  }
  return { hash: hash.digest("hex"), lineCount: isText ? lineCount : null, bytes };
}

async function visitSnapshot(rootPath, currentPath, entries, state) {
  for await (const entry of await fs.opendir(currentPath)) {
    state.entryCount += 1;
    if (state.entryCount > MAX_SNAPSHOT_ENTRIES) {
      throw new BenchmarkResourceLimitError("workspace snapshot entry count", MAX_SNAPSHOT_ENTRIES, state.entryCount, "entries");
    }
    const entryPath = path.join(currentPath, entry.name);
    const relativeEntryPath = relativePath(rootPath, entryPath);

    if (entry.isDirectory()) {
      if (SNAPSHOT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await visitSnapshot(rootPath, entryPath, entries, state);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (entries.size >= MAX_SNAPSHOT_FILES) {
      throw new BenchmarkResourceLimitError("workspace snapshot file count", MAX_SNAPSHOT_FILES, entries.size + 1, "files");
    }
    const stats = await fs.stat(entryPath);
    if (stats.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new BenchmarkResourceLimitError("workspace snapshot file", MAX_SNAPSHOT_FILE_BYTES, stats.size);
    }
    if (state.totalBytes + stats.size > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new BenchmarkResourceLimitError("workspace snapshot total", MAX_SNAPSHOT_TOTAL_BYTES, state.totalBytes + stats.size);
    }
    const isText = isProbablyTextFile(entryPath);
    const inspected = await inspectSnapshotFile(entryPath, isText);
    state.totalBytes += inspected.bytes;
    if (state.totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new BenchmarkResourceLimitError("workspace snapshot total", MAX_SNAPSHOT_TOTAL_BYTES, state.totalBytes);
    }

    entries.set(relativeEntryPath, {
      path: relativeEntryPath,
      absolutePath: entryPath,
      size: stats.size,
      hash: inspected.hash,
      isText,
      lineCount: inspected.lineCount,
    });
  }
}

export async function snapshotWorkspace(rootPath) {
  const entries = new Map();
  await visitSnapshot(rootPath, rootPath, entries, { totalBytes: 0, entryCount: 0 });
  return entries;
}

export function diffWorkspaceSnapshots(beforeSnapshot, afterSnapshot) {
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [filePath, afterEntry] of afterSnapshot.entries()) {
    const beforeEntry = beforeSnapshot.get(filePath);
    if (!beforeEntry) {
      added.push({
        path: filePath,
        status: "added",
        isText: afterEntry.isText,
        lineCountBefore: 0,
        lineCountAfter: afterEntry.lineCount,
        lineDelta: typeof afterEntry.lineCount === "number" ? afterEntry.lineCount : null,
      });
      continue;
    }

    if (beforeEntry.hash !== afterEntry.hash) {
      modified.push({
        path: filePath,
        status: "modified",
        isText: afterEntry.isText || beforeEntry.isText,
        lineCountBefore: beforeEntry.lineCount,
        lineCountAfter: afterEntry.lineCount,
        lineDelta:
          typeof beforeEntry.lineCount === "number" && typeof afterEntry.lineCount === "number"
            ? afterEntry.lineCount - beforeEntry.lineCount
            : null,
      });
    }
  }

  for (const [filePath, beforeEntry] of beforeSnapshot.entries()) {
    if (!afterSnapshot.has(filePath)) {
      deleted.push({
        path: filePath,
        status: "deleted",
        isText: beforeEntry.isText,
        lineCountBefore: beforeEntry.lineCount,
        lineCountAfter: 0,
        lineDelta: typeof beforeEntry.lineCount === "number" ? -beforeEntry.lineCount : null,
      });
    }
  }

  return {
    added: added.sort((a, b) => a.path.localeCompare(b.path)),
    modified: modified.sort((a, b) => a.path.localeCompare(b.path)),
    deleted: deleted.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function summarizeWorkspaceDiff(diff) {
  const changedFiles = [...diff.added, ...diff.modified];
  return {
    addedFileCount: diff.added.length,
    modifiedFileCount: diff.modified.length,
    deletedFileCount: diff.deleted.length,
    changedFileCount: changedFiles.length,
    generatedFileCount: diff.added.length,
    generatedTestFileCount: diff.added.filter((entry) => testFilePattern(entry.path)).length,
    changedTestFileCount: changedFiles.filter((entry) => testFilePattern(entry.path)).length,
    changedTextLineDelta: changedFiles.reduce((sum, entry) => sum + (entry.lineDelta || 0), 0),
    changedFiles,
    allChanges: [...diff.added, ...diff.modified, ...diff.deleted],
  };
}
