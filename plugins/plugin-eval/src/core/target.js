import fs from "node:fs/promises";
import path from "node:path";

import { isDirectory, isFile, pathExists, listImmediateDirectories, readJson } from "../lib/files.js";

export async function resolveTarget(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  if (await isFile(resolvedPath)) {
    if (path.basename(resolvedPath) === "SKILL.md") {
      return {
        kind: "skill",
        path: path.dirname(resolvedPath),
        entryPath: resolvedPath,
        name: path.basename(path.dirname(resolvedPath)),
      };
    }
    if (
      path.basename(resolvedPath) === "plugin.json" &&
      path.basename(path.dirname(resolvedPath)) === ".codex-plugin"
    ) {
      return {
        kind: "plugin",
        path: path.dirname(path.dirname(resolvedPath)),
        entryPath: resolvedPath,
        name: path.basename(path.dirname(path.dirname(resolvedPath))),
      };
    }

    return {
      kind: "file",
      path: resolvedPath,
      entryPath: resolvedPath,
      name: path.basename(resolvedPath),
    };
  }

  if (!(await isDirectory(resolvedPath))) {
    throw new Error(`Target path does not exist: ${resolvedPath}`);
  }

  const pluginManifestPath = path.join(resolvedPath, ".codex-plugin", "plugin.json");
  if (await pathExists(pluginManifestPath)) {
    return {
      kind: "plugin",
      path: resolvedPath,
      entryPath: pluginManifestPath,
      name: path.basename(resolvedPath),
    };
  }

  const skillPath = path.join(resolvedPath, "SKILL.md");
  if (await pathExists(skillPath)) {
    return {
      kind: "skill",
      path: resolvedPath,
      entryPath: skillPath,
      name: path.basename(resolvedPath),
    };
  }

  return {
    kind: "directory",
    path: resolvedPath,
    entryPath: resolvedPath,
    name: path.basename(resolvedPath),
  };
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolvePluginSkillsRoot(pluginRoot, configuredPath = "./skills/") {
  if (typeof configuredPath !== "string" || !configuredPath || configuredPath.includes("\0") ||
    configuredPath.includes("\\") || configuredPath.includes(":") ||
    path.posix.isAbsolute(configuredPath) || path.win32.isAbsolute(configuredPath)) {
    throw new Error("Plugin skills path must stay within the plugin root.");
  }
  const parts = configuredPath.replace(/^\.\//, "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Plugin skills path must stay within the plugin root.");
  }

  const rootPath = path.resolve(pluginRoot);
  const realRoot = await fs.realpath(rootPath);
  const skillsRoot = path.resolve(rootPath, ...parts);
  if (!isWithin(rootPath, skillsRoot)) {
    throw new Error("Plugin skills path must stay within the plugin root.");
  }
  let current = rootPath;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (!isWithin(realRoot, await fs.realpath(current))) {
      throw new Error("Plugin skills path must stay within the plugin root.");
    }
  }
  return skillsRoot;
}

export async function discoverPluginSkillDirectories(pluginRoot, manifest) {
  const skillsRoot = await resolvePluginSkillsRoot(pluginRoot, manifest?.skills || "./skills/");
  if (!(await isDirectory(skillsRoot))) {
    return [];
  }

  const candidates = await listImmediateDirectories(skillsRoot);
  const directories = [];
  for (const candidate of candidates) {
    const skillFile = path.join(candidate, "SKILL.md");
    if (await pathExists(skillFile)) {
      directories.push(candidate);
    }
  }
  return directories;
}

export async function loadPluginManifest(pluginRoot) {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  return readJson(manifestPath);
}
