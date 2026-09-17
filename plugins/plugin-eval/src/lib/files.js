import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
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
  "coverage",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8");
}

export async function readJson(targetPath) {
  return JSON.parse(await readText(targetPath));
}

export async function writeText(targetPath, content) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

export async function writeJson(targetPath, payload) {
  await writeText(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function assertUnlinkedPath(targetPath) {
  const resolved = path.resolve(targetPath);
  let current = path.parse(resolved).root;
  let deepestExisting = current;
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
      throw new Error("Implicit benchmark output paths must not contain links.");
    }
    deepestExisting = current;
  }
  const actual = await fs.realpath(deepestExisting);
  const expected = path.resolve(deepestExisting);
  if ((process.platform === "win32" ? actual.toLowerCase() : actual) !==
    (process.platform === "win32" ? expected.toLowerCase() : expected)) {
    throw new Error("Implicit benchmark output paths must not contain linked path components.");
  }
}

export async function ensureImplicitOutputDirectory(directoryPath) {
  const resolved = path.resolve(directoryPath);
  await assertUnlinkedPath(resolved);
  let current = path.parse(resolved).root;
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Implicit benchmark output paths must be ordinary directories.");
    }
  }
  await assertUnlinkedPath(resolved);
}

export async function writeImplicitOutputText(targetPath, content) {
  await ensureImplicitOutputDirectory(path.dirname(targetPath));
  await assertUnlinkedPath(targetPath);
  const temporaryPath = path.join(path.dirname(targetPath), `.plugin-eval-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await assertUnlinkedPath(path.dirname(targetPath));
    await assertUnlinkedPath(targetPath);
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function writeImplicitOutputJson(targetPath, payload) {
  await writeImplicitOutputText(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function isProbablyTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function relativePath(fromPath, toPath) {
  const value = path.relative(fromPath, toPath) || ".";
  return toPosixPath(value);
}

export function formatCommandPath(targetPath, options = {}) {
  const absoluteTargetPath = path.resolve(targetPath);
  const cwd = path.resolve(options.cwd || process.cwd());
  const homeDir = path.resolve(options.homeDir || os.homedir());

  if (absoluteTargetPath === homeDir) {
    return "~";
  }

  const relativeToHome = path.relative(homeDir, absoluteTargetPath);
  if (relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    const formatted = `~/${toPosixPath(relativeToHome)}`;
    return /^[a-zA-Z0-9_./:\\~-]+$/.test(formatted) ? formatted : quoteCommandArgument(absoluteTargetPath);
  }

  const relativeToCwd = path.relative(cwd, absoluteTargetPath) || ".";
  if (!relativeToCwd.startsWith("..") && !path.isAbsolute(relativeToCwd)) {
    const formatted = toPosixPath(relativeToCwd);
    return /^[a-zA-Z0-9_./:\\~-]+$/.test(formatted) && !formatted.startsWith("-")
      ? formatted : quoteCommandArgument(formatted);
  }

  const formatted = toPosixPath(absoluteTargetPath);
  return /^[a-zA-Z0-9_./:\\~-]+$/.test(formatted) ? formatted : quoteCommandArgument(formatted);
}

export function quoteCommandArgument(value) {
  const text = String(value);
  return process.platform === "win32"
    ? `'${text.replace(/(\\*)"/g, (_, slashes) => `${"\\".repeat(slashes.length * 2 + 1)}"`).replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", "'\\''")}'`;
}

export function formatGeneratedCommand(command) {
  if (process.platform !== "win32") return command;
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/plugin-eval.js");
  const nativeCommand = command.replace(/^plugin-eval(?=\s|$)/, `node ${quoteCommandArgument(cliPath)}`);
  // Keep dynamic arguments out of cmd.exe's expansion and metacharacter parsing.
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(nativeCommand, "utf16le").toString("base64")}`;
}

export async function walkFiles(rootPath, options = {}) {
  const files = [];
  const {
    excludeDirs = [],
    skipTopLevel = ["fixtures", "__fixtures__"],
  } = options;
  const excluded = new Set([...IGNORED_DIRS, ...excludeDirs]);

  async function visit(currentPath, depth = 0) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) {
          continue;
        }
        if (depth === 0 && skipTopLevel.includes(entry.name)) {
          continue;
        }
        await visit(entryPath, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  await visit(rootPath);
  return files.sort();
}

export async function listImmediateDirectories(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name))
    .sort();
}
