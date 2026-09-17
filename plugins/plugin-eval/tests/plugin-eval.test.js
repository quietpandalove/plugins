import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { analyzePath, explainBudget } from "../src/core/analyze.js";
import { initializeBenchmark, runBenchmark, runProcessCapture } from "../src/core/benchmark.js";
import { provisionBenchmarkWorkspace, snapshotWorkspace } from "../src/core/benchmark-workspace.js";
import { parseCodexJsonStream, summarizeCodexEvents } from "../src/core/benchmark-events.js";
import { compareResults } from "../src/core/compare.js";
import { buildWorkflowGuide } from "../src/core/workflow-guide.js";
import { analyzeCoverageArtifacts } from "../src/evaluators/coverage.js";
import { parseFrontmatter } from "../src/lib/frontmatter.js";
import { formatCommandPath, formatGeneratedCommand, quoteCommandArgument } from "../src/lib/files.js";
import { renderPayload } from "../src/renderers/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(repoRoot, "fixtures");
const cliPath = path.join(repoRoot, "scripts", "plugin-eval.js");
const nodeBin = process.execPath;

async function makeTempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`)));
}

function decodedGeneratedCommand(command) {
  if (process.platform !== "win32") return command;
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from(command.split(" ").at(-1), "base64").toString("utf16le");
  const cliExecutable = `node ${quoteCommandArgument(cliPath)}`;
  return decoded.startsWith(cliExecutable) ? `plugin-eval${decoded.slice(cliExecutable.length)}` : decoded;
}

async function writeSkillFixture(rootPath, { description, bodyLines }) {
  await fs.mkdir(rootPath, { recursive: true });
  const body = Array.from({ length: bodyLines }, (_, index) => `Line ${index + 1}`).join("\n");
  await fs.writeFile(
    path.join(rootPath, "SKILL.md"),
    `---\nname: temp-skill\ndescription: ${description}\n---\n\n# Temp Skill\n\n${body}\n`,
    "utf8",
  );
}

async function writeBlockScalarSkillFixture(rootPath, { style = ">", descriptionLines, bodyLines = 3 }) {
  await fs.mkdir(rootPath, { recursive: true });
  const description = descriptionLines.map((line) => `  ${line}`).join("\n");
  const body = Array.from({ length: bodyLines }, (_, index) => `Line ${index + 1}`).join("\n");
  await fs.writeFile(
    path.join(rootPath, "SKILL.md"),
    `---\nname: temp-skill\ndescription: ${style}\n${description}\n---\n\n# Temp Skill\n\n${body}\n`,
    "utf8",
  );
}

async function writePluginBudgetFixture(rootPath) {
  await fs.mkdir(path.join(rootPath, ".codex-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "policy-aware-plugin",
        version: "0.1.0",
        description: "Evaluate policy-aware plugin budgets.",
        author: {
          name: "Plugin Eval",
        },
        homepage: "https://example.com/",
        license: "MIT",
        keywords: ["fixture"],
        skills: "./skills/",
        interface: {
          displayName: "Policy Aware Plugin",
          shortDescription: "Fixture for policy-aware budgets",
          longDescription: "Fixture for policy-aware budget tests.",
          developerName: "Plugin Eval",
          category: "Developer Tools",
          capabilities: ["Read"],
          defaultPrompt: ["Route the request first."],
          brandColor: "#0B7285",
          composerIcon: "./assets/icon.svg",
          logo: "./assets/logo.svg",
          screenshots: [],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeSkillFixture(path.join(rootPath, "skills", "router"), {
    description: "Route fixture requests.",
    bodyLines: 3,
  });
  await fs.mkdir(path.join(rootPath, "skills", "router", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, "skills", "router", "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: true\n",
    "utf8",
  );

  await writeSkillFixture(path.join(rootPath, "skills", "specialist"), {
    description: `Specialist fixture ${"x".repeat(500)}`,
    bodyLines: 200,
  });
  await fs.mkdir(path.join(rootPath, "skills", "specialist", "agents"), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, "skills", "specialist", "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n",
    "utf8",
  );
}

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true });
}

async function createFakeCodexExecutable(rootPath) {
  const binDir = path.join(rootPath, "bin");
  const executablePath = path.join(binDir, "codex-fake.mjs");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-test");
  process.exit(0);
}

if (args[0] === "exec") {
  let final = "";
  let workspace = "";

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output-last-message") {
      final = args[index + 1];
    } else if (args[index] === "--cd") {
      workspace = args[index + 1];
    }
  }

  fs.mkdirSync(path.dirname(final), { recursive: true });
  fs.writeFileSync(final, "Implemented benchmark fixture.\\n", "utf8");
  fs.writeFileSync(path.join(workspace, "generated.ts"), "export const generated = 1;\\n", "utf8");
  fs.writeFileSync(
    path.join(workspace, "generated.test.ts"),
    'import { generated } from "./generated";\\nexport default generated;\\n',
    "utf8",
  );
  process.stdout.write('{"type":"thread.started","thread_id":"thread-test"}\\n');
  process.stdout.write('{"type":"tool.called","tool_name":"functions.exec_command"}\\n');
  process.stdout.write('{"type":"shell.command","command":"npm test"}\\n');
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":45,"total_tokens":165}}\\n');
  process.exit(0);
}

console.error("unsupported invocation");
process.exit(1);
`,
    "utf8",
  );
  await fs.chmod(executablePath, 0o755);
  return executablePath;
}

test("analyze minimal skill and render markdown/html", async () => {
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const result = await analyzePath(skillPath);

  assert.equal(result.target.kind, "skill");
  assert.equal(result.budgets.method, "estimated-static");
  assert.ok(result.summary.score > 0);
  assert.ok(result.metrics.some((metric) => metric.id === "trigger_cost_tokens"));
  assert.ok(Array.isArray(result.summary.whyBullets));
  assert.ok(Array.isArray(result.summary.fixFirst));
  assert.ok(result.nextAction);

  const markdown = renderPayload(result, "markdown");
  const html = renderPayload(result, "html");

  assert.match(markdown, /Plugin Eval Report: minimal-skill/);
  assert.match(markdown, /At a Glance/);
  assert.match(markdown, /Why It Matters/);
  assert.match(markdown, /Fix First/);
  assert.match(markdown, /Recommended Next Step/);
  assert.match(markdown, /<details>/);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Risk Assessment/);
  assert.match(html, /Use From Codex Chat/);
  assert.match(html, /Quick local entrypoint/);
});

test("flags oversized descriptions and bloated SKILL.md files", async () => {
  const tempDir = await makeTempDir("plugin-eval-skill");
  await writeSkillFixture(tempDir, {
    description: `Verbose description ${"x".repeat(1300)}`,
    bodyLines: 650,
  });

  const result = await analyzePath(tempDir);
  const ids = new Set(result.checks.map((check) => check.id));

  assert.ok(ids.has("description-too-long"));
  assert.ok(ids.has("skill-large") || ids.has("skill-too-large"));
  assert.notEqual(result.budgets.trigger_cost_tokens.band, "good");
});

test("parses folded and literal YAML block scalars in frontmatter", async () => {
  const folded = parseFrontmatter(`---\nname: temp-skill\ndescription: >\n  Use when the task needs\n  a folded block scalar.\n---\n`);
  const literal = parseFrontmatter(`---\nname: temp-skill\ndescription: |\n  First line.\n  Second line.\n---\n`);

  assert.deepEqual(folded.errors, []);
  assert.equal(folded.data.description, "Use when the task needs a folded block scalar.");

  assert.deepEqual(literal.errors, []);
  assert.equal(literal.data.description, "First line.\nSecond line.");
});

test("analyze accepts skills with block-scalar descriptions", async () => {
  const tempDir = await makeTempDir("plugin-eval-block-scalar");
  await writeBlockScalarSkillFixture(tempDir, {
    style: ">",
    descriptionLines: [
      "Use when the task needs",
      "a folded block scalar description.",
    ],
  });

  const result = await analyzePath(tempDir);
  const ids = new Set(result.checks.map((check) => check.id));

  assert.ok(!ids.has("frontmatter-invalid"));
  assert.ok(!ids.has("name-missing"));
  assert.ok(!ids.has("description-missing"));
  assert.ok(result.summary.score > 0);
});

test("explicit-only skill policy removes trigger budget", async () => {
  const tempDir = await makeTempDir("plugin-eval-explicit-skill");
  await writeSkillFixture(tempDir, {
    description: `Explicit-only description ${"x".repeat(500)}`,
    bodyLines: 10,
  });
  await fs.mkdir(path.join(tempDir, "agents"), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n",
    "utf8",
  );

  const result = await analyzePath(tempDir);

  assert.equal(result.budgets.method, "estimated-static-policy-aware");
  assert.equal(result.budgets.invocation_policy.allow_implicit_invocation, false);
  assert.equal(result.budgets.trigger_cost_tokens.value, 0);
  assert.ok(result.budgets.invoke_cost_tokens.value > 0);
  assert.ok(!result.checks.some((check) => check.id === "trigger_cost_tokens-budget-high"));
});

test("plugin budget excludes explicit-only specialist skills from implicit active budget", async () => {
  const tempDir = await makeTempDir("plugin-eval-policy-plugin");
  await writePluginBudgetFixture(tempDir);

  const result = await analyzePath(tempDir);
  const triggerLabels = result.budgets.trigger_cost_tokens.components.map((component) => component.label);
  const invokeLabels = result.budgets.invoke_cost_tokens.components.map((component) => component.label);
  const explicitLabels = result.budgets.explicit_only_invoke_cost_tokens.components.map((component) => component.label);

  assert.equal(result.target.kind, "plugin");
  assert.equal(result.budgets.method, "estimated-static-policy-aware");
  assert.equal(result.budgets.invocation_policy.implicit_skill_count, 1);
  assert.equal(result.budgets.invocation_policy.explicit_only_skill_count, 1);
  assert.ok(triggerLabels.includes("router-description"));
  assert.ok(!triggerLabels.includes("specialist-description"));
  assert.ok(invokeLabels.includes("router-skill-file"));
  assert.ok(!invokeLabels.includes("specialist-skill-file"));
  assert.deepEqual(explicitLabels, ["specialist-skill-file"]);
  assert.ok(result.metrics.some((metric) => metric.id === "explicit_only_invoke_cost_tokens"));
});

test("plugin skills path stays inside the plugin for analysis and budget", async () => {
  const tempDir = await makeTempDir("plugin-eval-skill-path");
  const pluginPath = path.join(tempDir, "policy-aware-plugin");
  const outsidePath = path.join(tempDir, "outside-skills");
  await writePluginBudgetFixture(pluginPath);
  await writeSkillFixture(path.join(outsidePath, "external"), { description: "Outside fixture.", bodyLines: 2 });
  const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const skills of ["./../outside-skills", outsidePath, "C:relative-skills", "\\\\server\\share\\skills"]) {
    manifest.skills = skills;
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await assert.rejects(() => analyzePath(pluginPath), /skills path must stay within the plugin root/);
    await assert.rejects(() => explainBudget(pluginPath), /skills path must stay within the plugin root/);
  }

  await fs.mkdir(path.join(pluginPath, "nested"));
  await fs.rename(path.join(pluginPath, "skills"), path.join(pluginPath, "nested", "skills"));
  manifest.skills = "./nested/skills/";
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const result = await analyzePath(pluginPath);
  assert.equal(result.metrics.find((metric) => metric.id === "plugin_skill_count")?.value, 2);
  assert.equal((await explainBudget(pluginPath)).budgets.invocation_policy.implicit_skill_count, 1);
});

test("plugin skills path rejects linked directories that escape the plugin", async (t) => {
  const tempDir = await makeTempDir("plugin-eval-linked-skill-path");
  const pluginPath = path.join(tempDir, "policy-aware-plugin");
  const outsidePath = path.join(tempDir, "outside-skills");
  await writePluginBudgetFixture(pluginPath);
  await writeSkillFixture(path.join(outsidePath, "external"), { description: "Outside fixture.", bodyLines: 2 });
  try {
    await fs.symlink(outsidePath, path.join(pluginPath, "linked-skills"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("directory links are unavailable");
    throw error;
  }
  const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.skills = "./linked-skills";
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await assert.rejects(() => analyzePath(pluginPath), /skills path must stay within the plugin root/);
  await assert.rejects(() => explainBudget(pluginPath), /skills path must stay within the plugin root/);
});

test("finds broken plugin manifests, missing paths, and prompt issues", async () => {
  const tempDir = await makeTempDir("plugin-eval-plugin");
  await fs.mkdir(path.join(tempDir, ".codex-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "bad-plugin",
        version: "0.1.0",
        description: "Broken plugin for testing.",
        author: {
          name: "Plugin Eval",
          email: "support@example.com",
          url: "https://example.com/",
        },
        homepage: "https://example.com/",
        repository: "https://example.com/repo",
        license: "MIT",
        keywords: ["fixture"],
        skills: "./missing-skills/",
        interface: {
          displayName: "Bad Plugin",
          shortDescription: "Broken fixture",
          longDescription: "Broken fixture for plugin-eval tests.",
          developerName: "Plugin Eval",
          category: "Developer Tools",
          capabilities: ["Interactive", "Write"],
          websiteURL: "https://example.com/",
          privacyPolicyURL: "https://example.com/privacy",
          termsOfServiceURL: "https://example.com/terms",
          defaultPrompt: [
            "Prompt one that is fine.",
            "Prompt two that is also fine.",
            "Prompt three that is also fine.",
            "Prompt four is ignored and should be flagged because there are too many starter prompts in this broken fixture, and this sentence is intentionally extended well past the interface length budget so the evaluator can deterministically flag it as too long."
          ],
          brandColor: "teal",
          composerIcon: "./assets/missing.svg",
          logo: "./assets/missing.svg",
          screenshots: []
        }
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await analyzePath(tempDir);
  const ids = new Set(result.checks.map((check) => check.id));

  assert.ok(ids.has("skills-path-missing"));
  assert.ok(ids.has("default-prompt-too-many"));
  assert.ok(ids.has("default-prompt-too-long"));
  assert.ok(ids.has("brand-color-invalid"));
  assert.ok(ids.has("plugin-skills-missing"));
});

test("collects deterministic TypeScript and Python metrics", async () => {
  const samplePath = path.join(fixturesRoot, "ts-python-sample");
  const result = await analyzePath(samplePath);

  const metric = (id) => result.metrics.find((item) => item.id === id)?.value;

  assert.equal(metric("ts_file_count"), 2);
  assert.equal(metric("py_file_count"), 2);
  assert.equal(metric("ts_test_file_count"), 1);
  assert.equal(metric("py_test_file_count"), 1);
  assert.ok(metric("ts_max_cyclomatic_complexity") >= 4);
  assert.ok(metric("py_max_cyclomatic_complexity") >= 4);
});

test("ingests lcov, coverage.xml, and coverage-final.json artifacts", async () => {
  const samplePath = path.join(fixturesRoot, "coverage-samples");
  const result = await analyzePath(samplePath);
  const coveragePercent = result.metrics.find((metric) => metric.id === "coverage_percent")?.value;

  assert.equal(coveragePercent, 82);
  assert.equal(result.metrics.find((metric) => metric.id === "coverage_artifact_count")?.value, 3);
});

test("merges custom metric pack output without changing the core summary", async () => {
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const result = await analyzePath(skillPath, {
    metricPackManifests: [path.join(fixturesRoot, "metric-pack", "manifest.json")],
  });

  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0].metrics[0].id, "custom-pack-score");
  assert.ok(result.summary.score > 0);
});

test("ingests observed usage files and compares estimates against real sessions", async () => {
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const usagePath = path.join(fixturesRoot, "observed-usage", "responses.jsonl");
  const result = await analyzePath(skillPath, {
    observedUsagePaths: [usagePath],
  });

  assert.equal(result.observedUsage.sampleCount, 3);
  assert.equal(result.metrics.find((metric) => metric.id === "observed_usage_sample_count")?.value, 3);
  assert.ok(result.metrics.some((metric) => metric.id === "estimate_vs_observed_input_ratio"));
  assert.ok(result.measurementPlan.toolsets.length >= 5);
});

test("init-benchmark writes a beginner-friendly starter config", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-benchmark-init");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(sourcePath, skillPath);

  const payload = await initializeBenchmark(skillPath);
  const config = JSON.parse(await fs.readFile(path.join(skillPath, ".plugin-eval", "benchmark.json"), "utf8"));

  assert.equal(payload.kind, "benchmark-template-init");
  assert.equal(config.kind, "plugin-eval-benchmark");
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.runner.type, "codex-cli");
  assert.equal(config.workspace.setupMode, "copy");
  assert.equal(config.scenarios.length, 3);
  assert.ok(Array.isArray(config.setupQuestions));
  assert.ok(config.setupQuestions.length >= 3);
  assert.match(config.notes[0], /workspace\.sourcePath/i);
  assert.ok(Array.isArray(payload.setupQuestions));
  assert.ok(payload.setupQuestions.some((item) => /must-pass/i.test(item)));
  assert.ok(payload.workflowGuide);
  await initializeBenchmark(skillPath);
  assert.equal(JSON.parse(await fs.readFile(path.join(skillPath, ".plugin-eval", "benchmark.json"), "utf8")).kind, "plugin-eval-benchmark");
});

test("implicit benchmark output refuses linked directories but explicit output remains available", async (t) => {
  const tempDir = await makeTempDir("plugin-eval-output-link");
  const skillPath = path.join(tempDir, "minimal-skill");
  const outsidePath = path.join(tempDir, "outside-output");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await fs.mkdir(outsidePath);
  try {
    await fs.symlink(outsidePath, path.join(skillPath, ".plugin-eval"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("directory links are unavailable");
    throw error;
  }
  await assert.rejects(() => initializeBenchmark(skillPath), /Implicit benchmark output paths/);
  await assert.rejects(() => fs.stat(path.join(outsidePath, "benchmark.json")), { code: "ENOENT" });

  const configPath = path.join(tempDir, "reviewed-config.json");
  await initializeBenchmark(skillPath, { outputPath: configPath });
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  let launches = 0;
  await assert.rejects(() => runBenchmark(skillPath, {
    configPath,
    workspaceSourcePath: process.cwd(),
    processRunner: async () => { launches += 1; throw new Error("unexpected launch"); },
  }), /Implicit benchmark output paths/);
  assert.equal(launches, 0);
});

test("benchmark refuses a linked runs directory before starting a child", async (t) => {
  const tempDir = await makeTempDir("plugin-eval-linked-runs");
  const skillPath = path.join(tempDir, "minimal-skill");
  const outsidePath = path.join(tempDir, "outside-runs");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await initializeBenchmark(skillPath);
  await fs.mkdir(outsidePath);
  try {
    await fs.symlink(outsidePath, path.join(skillPath, ".plugin-eval", "runs"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("directory links are unavailable");
    throw error;
  }
  let launches = 0;
  await assert.rejects(() => runBenchmark(skillPath, {
    configPath: path.join(skillPath, ".plugin-eval", "benchmark.json"),
    workspaceSourcePath: process.cwd(),
    processRunner: async () => { launches += 1; throw new Error("unexpected launch"); },
  }), /Implicit benchmark output paths/);
  assert.equal(launches, 0);
  assert.deepEqual(await fs.readdir(outsidePath), []);
});

test("implicit benchmark output refuses a linked destination file", async (t) => {
  const tempDir = await makeTempDir("plugin-eval-output-file-link");
  const skillPath = path.join(tempDir, "minimal-skill");
  const outsidePath = path.join(tempDir, "outside.json");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await fs.mkdir(path.join(skillPath, ".plugin-eval"));
  await fs.writeFile(outsidePath, "fixture unchanged", "utf8");
  try {
    await fs.symlink(outsidePath, path.join(skillPath, ".plugin-eval", "benchmark.json"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("file links are unavailable");
    throw error;
  }
  await assert.rejects(() => initializeBenchmark(skillPath), /Implicit benchmark output paths/);
  assert.equal(await fs.readFile(outsidePath, "utf8"), "fixture unchanged");
});

test("implicit benchmark output refuses a hard-linked destination file", async () => {
  const tempDir = await makeTempDir("plugin-eval-output-hardlink");
  const skillPath = path.join(tempDir, "minimal-skill");
  const outsidePath = path.join(tempDir, "outside.json");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await fs.mkdir(path.join(skillPath, ".plugin-eval"));
  await fs.writeFile(outsidePath, "fixture unchanged", "utf8");
  await fs.link(outsidePath, path.join(skillPath, ".plugin-eval", "benchmark.json"));
  await assert.rejects(() => initializeBenchmark(skillPath), /Implicit benchmark output paths/);
  assert.equal(await fs.readFile(outsidePath, "utf8"), "fixture unchanged");
});

test("benchmark rejects the removed dry-run mode", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-benchmark-dry-run");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(sourcePath, skillPath);

  await initializeBenchmark(skillPath);
  await assert.rejects(
    () =>
      runBenchmark(skillPath, {
        configPath: path.join(skillPath, ".plugin-eval", "benchmark.json"),
        workspaceSourcePath: process.cwd(),
        dryRun: true,
      }),
    /no longer supports --dry-run/i,
  );
});

test("parses codex json event streams and extracts usage plus shell activity", async () => {
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    JSON.stringify({ type: "tool.called", tool_name: "functions.exec_command" }),
    JSON.stringify({ type: "shell.command", command: "npm test" }),
    "warning text that should be ignored",
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, output_tokens: 44, total_tokens: 145 } }),
  ].join("\n");

  const parsed = parseCodexJsonStream(stream);
  const summary = summarizeCodexEvents(parsed.events);

  assert.equal(parsed.events.length, 4);
  assert.equal(parsed.ignoredLines.length, 1);
  assert.equal(summary.threadId, "thread-123");
  assert.equal(summary.toolCallCount, 1);
  assert.equal(summary.shellCommandCount, 1);
  assert.equal(summary.failedShellCommandCount, 0);
  assert.equal(summary.usage.input_tokens, 101);
  assert.equal(summary.finalStatus, "completed");
});

test("formats command paths with home shorthand for user-facing commands", () => {
  const formatted = formatCommandPath(path.join(os.homedir(), ".codex", "skills", "game-dev"), {
    cwd: repoRoot,
  });

  assert.equal(formatted, "~/.codex/skills/game-dev");
});

test("workflow guide next action uses the first actionable local command", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-workflow-guide");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(sourcePath, skillPath);

  const guide = await buildWorkflowGuide(skillPath, {
    request: "Measure the real token usage of this skill.",
  });

  assert.equal(decodedGeneratedCommand(guide.nextAction.command), `plugin-eval init-benchmark ${formatCommandPath(skillPath)}`);
});

test("child capture rejects excess stdout and stderr without returning truncated output", async () => {
  const tempDir = await makeTempDir("plugin-eval-capture-limit");
  for (const stream of ["stdout", "stderr"]) {
    const script = `process.${stream}.write("x".repeat(2048))`;
    await assert.rejects(() => runProcessCapture({
      command: nodeBin,
      args: ["-e", script],
      cwd: tempDir,
      env: process.env,
      stdoutLimitBytes: 1024,
      stderrLimitBytes: 1024,
    }), new RegExp(`child ${stream} exceeded`));
  }
  const ordinary = await runProcessCapture({
    command: nodeBin,
    args: ["-e", "process.stdout.write('ok')"],
    cwd: tempDir,
    env: process.env,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
  });
  assert.equal(ordinary.code, 0);
  assert.equal(ordinary.stdoutText, "ok");
});

test("workspace snapshot refuses oversized files without reading them into memory", async () => {
  const tempDir = await makeTempDir("plugin-eval-snapshot-limit");
  const largeFile = path.join(tempDir, "generated.ts");
  await fs.writeFile(largeFile, "", "utf8");
  await fs.truncate(largeFile, 64 * 1024 * 1024 + 1);
  await assert.rejects(() => snapshotWorkspace(tempDir), /workspace snapshot file exceeded/);
  await fs.writeFile(largeFile, "line one\nline two\n", "utf8");
  assert.equal((await snapshotWorkspace(tempDir)).get("generated.ts")?.lineCount, 3);
});

test("benchmark records safe diagnostics when a generated workspace file exceeds the snapshot limit", async () => {
  const tempDir = await makeTempDir("plugin-eval-snapshot-diagnostics");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await initializeBenchmark(skillPath);
  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(() => runBenchmark(skillPath, {
    configPath,
    workspaceSourcePath: process.cwd(),
    processRunner: async ({ kind, args }) => {
      if (kind === "codex") {
        const workspace = args[args.indexOf("--cd") + 1];
        const generated = path.join(workspace, "generated.ts");
        await fs.writeFile(generated, "", "utf8");
        await fs.truncate(generated, 64 * 1024 * 1024 + 1);
      }
      return { code: 0, signal: null, durationMs: 1, stdoutText: "", stderrText: "" };
    },
  }), /workspace snapshot file exceeded/);
  const runsRoot = path.join(skillPath, ".plugin-eval", "runs");
  const runs = await fs.readdir(runsRoot);
  const scenarios = await fs.readdir(path.join(runsRoot, runs[0]));
  const diagnostics = JSON.parse(await fs.readFile(path.join(runsRoot, runs[0], scenarios[0], "diagnostics.json"), "utf8"));
  assert.equal(diagnostics.rawOutputRetained, false);
  assert.equal(diagnostics.status, "resource-limit-exceeded");
  assert.equal(diagnostics.resource, "workspace snapshot file");
});

test("coverage readers reject oversized files in snapshot-ignored directories", async () => {
  const tempDir = await makeTempDir("plugin-eval-coverage-limit");
  const distPath = path.join(tempDir, "dist");
  await fs.mkdir(distPath);
  for (const name of ["lcov.info", "coverage.xml", "coverage-final.json", "coverage-summary.json"]) {
    const filePath = path.join(distPath, name);
    await fs.writeFile(filePath, "", "utf8");
    await fs.truncate(filePath, 64 * 1024 * 1024 + 1);
    assert.equal((await snapshotWorkspace(tempDir)).size, 0);
    await assert.rejects(() => analyzeCoverageArtifacts(tempDir), /coverage file exceeded/);
    await fs.rm(filePath);
  }

  await fs.writeFile(path.join(distPath, "lcov.info"), "LF:4\nLH:3\n", "utf8");
  await fs.writeFile(path.join(distPath, "coverage.xml"), '<coverage line-rate="0.75"/>', "utf8");
  await fs.writeFile(path.join(distPath, "coverage-summary.json"), '{"total":{"lines":{"pct":75}}}', "utf8");
  const analysis = await analyzeCoverageArtifacts(tempDir);
  assert.equal(analysis.metrics.find((metric) => metric.id === "coverage_artifact_count")?.value, 3);
  assert.equal(analysis.metrics.find((metric) => metric.id === "coverage_percent")?.value, 75);
});

test("LCOV reader bounds newline-heavy and overlong lines without losing valid CRLF records", async () => {
  const tempDir = await makeTempDir("plugin-eval-lcov-lines");
  const distPath = path.join(tempDir, "dist");
  await fs.mkdir(distPath);
  const filePath = path.join(distPath, "lcov.info");

  const newlineHeavy = Buffer.alloc(1000001, 10);
  assert.ok(newlineHeavy.length < 64 * 1024 * 1024);
  await fs.writeFile(filePath, newlineHeavy);
  await assert.rejects(() => analyzeCoverageArtifacts(tempDir), /coverage LCOV line count exceeded the 1000000 lines limit/);

  await fs.writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 120));
  await assert.rejects(() => analyzeCoverageArtifacts(tempDir), /coverage LCOV line exceeded the 1048576 bytes limit/);

  await fs.writeFile(filePath, `TN:${"x".repeat(70 * 1024)}\r\nLF:4\r\nLH:3\r\n`, "utf8");
  const analysis = await analyzeCoverageArtifacts(tempDir);
  assert.equal(analysis.metrics.find((metric) => metric.id === "coverage_percent")?.value, 75);
});

test("benchmark fails with safe diagnostics for oversized dist coverage", async () => {
  const tempDir = await makeTempDir("plugin-eval-dist-coverage");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await initializeBenchmark(skillPath);
  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(() => runBenchmark(skillPath, {
    configPath,
    workspaceSourcePath: process.cwd(),
    processRunner: async ({ kind, args }) => {
      if (kind === "codex") {
        const workspace = args[args.indexOf("--cd") + 1];
        const distPath = path.join(workspace, "dist");
        await fs.mkdir(distPath);
        const coveragePath = path.join(distPath, "coverage.xml");
        await fs.writeFile(coveragePath, "", "utf8");
        await fs.truncate(coveragePath, 64 * 1024 * 1024 + 1);
      }
      return { code: 0, signal: null, durationMs: 1, stdoutText: "", stderrText: "" };
    },
  }), /coverage file exceeded/);
  const runsRoot = path.join(skillPath, ".plugin-eval", "runs");
  const runs = await fs.readdir(runsRoot);
  const scenarios = await fs.readdir(path.join(runsRoot, runs[0]));
  const diagnostics = JSON.parse(await fs.readFile(path.join(runsRoot, runs[0], scenarios[0], "diagnostics.json"), "utf8"));
  assert.equal(diagnostics.rawOutputRetained, false);
  assert.equal(diagnostics.status, "resource-limit-exceeded");
  assert.equal(diagnostics.resource, "coverage file");
});

test("benchmark run writes usage logs and generated-code analysis from a codex-cli run", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-benchmark-live");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(sourcePath, skillPath);

  await initializeBenchmark(skillPath);
  const payload = await runBenchmark(skillPath, {
    configPath: path.join(skillPath, ".plugin-eval", "benchmark.json"),
    workspaceSourcePath: process.cwd(),
    processRunner: async ({ kind, args }) => {
      if (kind === "codex-version") {
        return {
          code: 0,
          signal: null,
          durationMs: 1,
          stdoutText: "codex-cli fake-test\n",
          stderrText: "",
        };
      }

      if (kind === "codex") {
        const finalMessagePath = args[args.indexOf("--output-last-message") + 1];
        const workspacePath = args[args.indexOf("--cd") + 1];
        await fs.writeFile(finalMessagePath, "Benchmark completed.\n", "utf8");
        await fs.writeFile(path.join(workspacePath, "generated.ts"), "export const value = 1;\n", "utf8");
        await fs.writeFile(path.join(workspacePath, "generated.test.ts"), "import { value } from './generated';\nconsole.log(value);\n", "utf8");
        return {
          code: 0,
          signal: null,
          durationMs: 10,
          stdoutText: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
            JSON.stringify({ type: "tool.called", tool_name: "functions.exec_command" }),
            JSON.stringify({ type: "shell.command", command: "npm test" }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 150, output_tokens: 70, total_tokens: 220 } }),
          ].join("\n"),
          stderrText: "",
        };
      }

      return {
        code: 0,
        signal: null,
        durationMs: 5,
        stdoutText: "",
        stderrText: "",
      };
    },
  });

  assert.equal(payload.mode, "codex-cli");
  assert.equal(payload.summary.sampleCount, 3);
  assert.equal(payload.summary.generatedFileCount, 6);
  assert.equal(payload.summary.generatedTestFileCount, 3);
  assert.equal(payload.scenarios[0].generatedCode.metrics.find((metric) => metric.id === "ts_file_count")?.value, 2);

  const result = await analyzePath(skillPath, {
    observedUsagePaths: [payload.usageLogPath],
  });
  assert.equal(result.observedUsage.sampleCount, 3);
});

test("benchmark run uses config-based approval policy syntax for codex exec", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-benchmark-args");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(sourcePath, skillPath);

  await initializeBenchmark(skillPath);
  const seenArgs = [];

  await runBenchmark(skillPath, {
    configPath: path.join(skillPath, ".plugin-eval", "benchmark.json"),
    workspaceSourcePath: process.cwd(),
    processRunner: async ({ kind, args }) => {
      if (kind === "codex-version") {
        return {
          code: 0,
          signal: null,
          durationMs: 1,
          stdoutText: "codex-cli fake-test\n",
          stderrText: "",
        };
      }

      if (kind === "codex") {
        seenArgs.push(args);
        const finalMessagePath = args[args.indexOf("--output-last-message") + 1];
        const workspacePath = args[args.indexOf("--cd") + 1];
        await fs.writeFile(finalMessagePath, "Benchmark completed.\n", "utf8");
        await fs.writeFile(path.join(workspacePath, "generated.ts"), "export const value = 1;\n", "utf8");
        return {
          code: 0,
          signal: null,
          durationMs: 10,
          stdoutText: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 150, output_tokens: 70, total_tokens: 220 } }),
          ].join("\n"),
          stderrText: "",
        };
      }

      return {
        code: 0,
        signal: null,
        durationMs: 5,
        stdoutText: "",
        stderrText: "",
      };
    },
  });

  assert.equal(seenArgs.length, 3);
  assert.ok(seenArgs.every((args) => !args.includes("-a")));
  assert.ok(seenArgs.every((args) => args.includes("-c")));
  assert.ok(seenArgs.every((args) => args.includes('approval_policy="never"')));
});

test("provisionBenchmarkWorkspace seeds auth and config into the isolated codex home", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-benchmark-home");
  const skillPath = path.join(tempDir, "minimal-skill");
  const codexHomeSource = path.join(tempDir, "codex-home-source");
  await copyDirectory(sourcePath, skillPath);
  await fs.mkdir(codexHomeSource, { recursive: true });
  await fs.writeFile(path.join(codexHomeSource, "auth.json"), '{"token":"test"}\n', "utf8");
  await fs.writeFile(path.join(codexHomeSource, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

  const previousSource = process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
  process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = codexHomeSource;

  const provisioned = await provisionBenchmarkWorkspace({
    target: {
      kind: "skill",
      name: "minimal-skill",
      path: skillPath,
    },
    config: {
      workspace: {
        sourcePath: skillPath,
        setupMode: "copy",
      },
      targetProvisioning: {
        mode: "isolated-skill-home",
      },
    },
    scenarioId: "seed-auth",
  });

  try {
    assert.equal(
      await fs.readFile(path.join(provisioned.codexHomePath, "auth.json"), "utf8"),
      '{"token":"test"}\n',
    );
    assert.equal(
      await fs.readFile(path.join(provisioned.codexHomePath, "config.toml"), "utf8"),
      'model = "gpt-5.4"\n',
    );
  } finally {
    if (previousSource === undefined) {
      delete process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
    } else {
      process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = previousSource;
    }
    await provisioned.cleanup();
  }
});

test("provisionBenchmarkWorkspace does not seed default user auth into the isolated codex home", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-benchmark-default-home");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(sourcePath, skillPath);

  const previousSource = process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
  delete process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;

  const provisioned = await provisionBenchmarkWorkspace({
    target: {
      kind: "skill",
      name: "minimal-skill",
      path: skillPath,
    },
    config: {
      workspace: {
        sourcePath: skillPath,
        setupMode: "copy",
      },
      targetProvisioning: {
        mode: "isolated-skill-home",
      },
    },
    scenarioId: "default-home",
  });

  try {
    await assert.rejects(
      () => fs.readFile(path.join(provisioned.codexHomePath, "auth.json"), "utf8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      () => fs.readFile(path.join(provisioned.codexHomePath, "config.toml"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    if (previousSource === undefined) {
      delete process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
    } else {
      process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = previousSource;
    }
    await provisioned.cleanup();
  }
});

test("benchmark rejects implicit config, worktrees, and executable verifiers before launching", async () => {
  const tempDir = await makeTempDir("plugin-eval-verifier-gate");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await initializeBenchmark(skillPath);
  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  config.verifiers.commands = ["echo unsafe"];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  let launches = 0;
  const processRunner = async () => { launches += 1; throw new Error("unexpected launch"); };

  await assert.rejects(() => runBenchmark(skillPath, { processRunner }), /explicit --config/);
  await assert.rejects(() => runBenchmark(skillPath, { configPath, processRunner }), /--workspace-source/);
  await assert.rejects(() => runBenchmark(skillPath, { configPath, workspaceSourcePath: tempDir, processRunner }), /--workspace-source/);
  await assert.rejects(() => runBenchmark(skillPath, { configPath, workspaceSourcePath: process.cwd(), allowVerifiers: true, processRunner }), /Executable verifiers are disabled/);
  config.verifiers.commands = [{ executable: nodeBin, args: ["--version"] }];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(() => runBenchmark(skillPath, { configPath, workspaceSourcePath: process.cwd(), processRunner }), /Executable verifiers are disabled/);
  config.verifiers.commands = [];
  config.workspace.setupMode = "git-worktree";
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(() => runBenchmark(skillPath, { configPath, workspaceSourcePath: process.cwd(), processRunner }), /git-worktree is disabled/);
  await assert.rejects(() => provisionBenchmarkWorkspace({ target: { kind: "skill", name: "minimal-skill", path: skillPath }, config, scenarioId: "worktree" }), /git-worktree is disabled/);
  config.workspace.setupMode = "copy";
  config.runner.sandbox = "danger-full-access";
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(() => runBenchmark(skillPath, { configPath, workspaceSourcePath: process.cwd(), processRunner }), /workspace-write/);
  config.runner.sandbox = "workspace-write";
  config.verifiers.files = ["../outside.txt"];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(() => runBenchmark(skillPath, { configPath, workspaceSourcePath: process.cwd(), processRunner }), /exact relative file paths/);
  assert.equal(launches, 0);
});

test("benchmark file checks do not spawn verifier processes and retain a scoped environment", async () => {
  const tempDir = await makeTempDir("plugin-eval-verifier-exec");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await initializeBenchmark(skillPath);
  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  config.verifiers.files = ["generated.ts", "README.md"];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  const previous = process.env.PLUGIN_EVAL_TEST_SECRET;
  process.env.PLUGIN_EVAL_TEST_SECRET = "fixture-only-value";
  const calls = [];
  try {
    const payload = await runBenchmark(skillPath, {
      configPath,
      workspaceSourcePath: process.cwd(),
      workspaceIncludes: ["README.md"],
      processRunner: async (call) => {
        calls.push(call);
        if (call.kind === "codex") {
          const finalPath = call.args[call.args.indexOf("--output-last-message") + 1];
          await fs.writeFile(finalPath, "Done\n", "utf8");
          const workspacePath = call.args[call.args.indexOf("--cd") + 1];
          await fs.writeFile(path.join(workspacePath, "generated.ts"), "export const done = true;\n", "utf8");
        }
        return { code: 0, signal: null, durationMs: 1, stdoutText: "", stderrText: "" };
      },
    });
    assert.equal(payload.scenarios[0].verifierResults[0].status, "passed");
    assert.equal(payload.scenarios[0].verifierResults[1].status, "failed");
    assert.equal(calls.some((call) => call.kind === "verifier"), false);
    assert.ok(calls.every((call) => !("PLUGIN_EVAL_TEST_SECRET" in call.env)));
    assert.ok(calls.every((call) => !("OPENAI_API_KEY" in call.env)));
    assert.equal(calls.find((call) => call.kind === "codex").env.CODEX_HOME.endsWith(`${path.sep}.codex`), true);
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_EVAL_TEST_SECRET;
    else process.env.PLUGIN_EVAL_TEST_SECRET = previous;
  }
});

test("workspace and target staging copy only explicitly named files", async () => {
  const tempDir = await makeTempDir("plugin-eval-private-copy");
  const skillPath = path.join(tempDir, "minimal-skill");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await fs.mkdir(path.join(skillPath, "private"));
  await fs.writeFile(path.join(skillPath, "private", "backup.bin"), "fixture-only-value", "utf8");
  await fs.writeFile(path.join(skillPath, "safe.txt"), "fixture text", "utf8");
  const config = { workspace: { sourcePath: skillPath, setupMode: "copy" }, targetProvisioning: { mode: "isolated-skill-home" } };
  const target = { kind: "skill", name: "minimal-skill", path: skillPath };
  const provisioned = await provisionBenchmarkWorkspace({ target, config, scenarioId: "private", workspaceIncludes: ["safe.txt"] });
  try {
    assert.equal(await fs.readFile(path.join(provisioned.workspacePath, "safe.txt"), "utf8"), "fixture text");
    await assert.rejects(() => fs.stat(path.join(provisioned.workspacePath, "private", "backup.bin")), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(path.join(provisioned.codexHomePath, "skills", "minimal-skill", "private", "backup.bin")), { code: "ENOENT" });
  } finally {
    await provisioned.cleanup();
  }
  await assert.rejects(() => provisionBenchmarkWorkspace({ target, config, scenarioId: "escape", workspaceIncludes: ["../private/backup.bin"] }), /exact relative file paths/);
  await assert.rejects(() => provisionBenchmarkWorkspace({ target, config, scenarioId: "absolute", workspaceIncludes: [path.join(skillPath, "safe.txt")] }), /exact relative file paths/);
  await assert.rejects(() => provisionBenchmarkWorkspace({ target, config, scenarioId: "directory", workspaceIncludes: ["private"] }), /regular files/);
});

test("plugin staging includes its manifest and explicitly selected skill files", async () => {
  const tempDir = await makeTempDir("plugin-eval-plugin-staging");
  const pluginPath = path.join(tempDir, "minimal-plugin");
  await copyDirectory(path.join(fixturesRoot, "minimal-plugin"), pluginPath);
  await fs.writeFile(path.join(pluginPath, "unlisted.bin"), "fixture-only-value", "utf8");
  const target = { kind: "plugin", name: "minimal-plugin", path: pluginPath };
  const config = { workspace: { sourcePath: tempDir, setupMode: "copy" }, targetProvisioning: { mode: "workspace-plugin-marketplace" } };
  await assert.rejects(() => provisionBenchmarkWorkspace({ target, config, scenarioId: "missing-plugin-files" }), /--target-include/);
  const provisioned = await provisionBenchmarkWorkspace({
    target,
    config,
    scenarioId: "plugin-files",
    targetIncludes: ["skills/minimal-plugin-skill/SKILL.md"],
  });
  try {
    const install = path.join(provisioned.workspacePath, "plugins", "minimal-plugin");
    assert.ok(await fs.stat(path.join(install, ".codex-plugin", "plugin.json")));
    assert.ok(await fs.stat(path.join(install, "skills", "minimal-plugin-skill", "SKILL.md")));
    await assert.rejects(() => fs.stat(path.join(install, "unlisted.bin")), { code: "ENOENT" });
  } finally {
    await provisioned.cleanup();
  }
});

test("staging rejects symlinked source ancestors", async (t) => {
  const tempDir = await makeTempDir("plugin-eval-source-link");
  const realSource = path.join(tempDir, "real-source");
  const alias = path.join(tempDir, "alias");
  const nestedSource = path.join(realSource, "nested");
  await fs.mkdir(nestedSource, { recursive: true });
  await fs.writeFile(path.join(nestedSource, "data.txt"), "fixture text", "utf8");
  try {
    await fs.symlink(realSource, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("directory links are unavailable");
    throw error;
  }
  const target = { kind: "skill", name: "minimal-skill", path: path.join(fixturesRoot, "minimal-skill") };
  const config = { workspace: { sourcePath: path.join(alias, "nested"), setupMode: "copy" }, targetProvisioning: { mode: "isolated-skill-home" } };
  await assert.rejects(() => provisionBenchmarkWorkspace({ target, config, scenarioId: "source-link", workspaceIncludes: ["data.txt"] }), /symbolic links/);
});

test("scoped Codex home refuses linked credential files", async (t) => {
  const tempDir = await makeTempDir("plugin-eval-linked-auth");
  const credentialHome = path.join(tempDir, "scoped-home");
  const externalFile = path.join(tempDir, "external-fixture.json");
  await fs.mkdir(credentialHome);
  await fs.writeFile(externalFile, '{"token":"fixture-only-value"}', "utf8");
  try {
    await fs.symlink(externalFile, path.join(credentialHome, "auth.json"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("file links are unavailable");
    throw error;
  }
  const previous = process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
  process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = credentialHome;
  try {
    const target = { kind: "skill", name: "minimal-skill", path: path.join(fixturesRoot, "minimal-skill") };
    const config = { workspace: { sourcePath: tempDir, setupMode: "copy" }, targetProvisioning: { mode: "isolated-skill-home" } };
    await assert.rejects(() => provisionBenchmarkWorkspace({ target, config, scenarioId: "linked-auth" }), /regular files/);
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
    else process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = previous;
  }
});

test("failed benchmarks remove explicitly seeded credentials and do not preserve workspace", async () => {
  const tempDir = await makeTempDir("plugin-eval-failed-credential-cleanup");
  const skillPath = path.join(tempDir, "minimal-skill");
  const credentialHome = path.join(tempDir, "scoped-home");
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await fs.mkdir(credentialHome);
  await fs.writeFile(path.join(credentialHome, "auth.json"), '{"token":"fixture-only-value"}', "utf8");
  await initializeBenchmark(skillPath);
  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  const previous = process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
  process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = credentialHome;
  try {
    const payload = await runBenchmark(skillPath, {
      configPath,
      workspaceSourcePath: process.cwd(),
      processRunner: async ({ kind }) => ({ code: kind === "codex" ? 1 : 0, signal: null, durationMs: 1, stdoutText: "", stderrText: "" }),
    });
    const scenario = payload.scenarios[0];
    assert.equal(scenario.status, "failed");
    assert.equal(scenario.workspacePath, null);
    await assert.rejects(() => fs.stat(scenario.codexHomePath), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
    else process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = previous;
  }
});

test("benchmark retains diagnostics without emitted credential text", async () => {
  const tempDir = await makeTempDir("plugin-eval-output-retention");
  const skillPath = path.join(tempDir, "minimal-skill");
  const credentialHome = path.join(tempDir, "scoped-home");
  const marker = "fixture-only-value";
  await copyDirectory(path.join(fixturesRoot, "minimal-skill"), skillPath);
  await fs.mkdir(credentialHome);
  await fs.writeFile(path.join(credentialHome, "auth.json"), JSON.stringify({ token: marker }), "utf8");
  await initializeBenchmark(skillPath);
  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.scenarios = config.scenarios.slice(0, 1);
  config.verifiers.files = ["generated.ts"];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  const previous = process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
  process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = credentialHome;
  try {
    const payload = await runBenchmark(skillPath, {
      configPath,
      workspaceSourcePath: process.cwd(),
      processRunner: async ({ kind, args }) => {
        if (kind === "codex-version") {
          return { code: 0, signal: null, durationMs: 1, stdoutText: `codex-cli 0.0.0\n${marker}`, stderrText: marker };
        }
        const finalPath = args[args.indexOf("--output-last-message") + 1];
        const workspacePath = args[args.indexOf("--cd") + 1];
        await fs.writeFile(finalPath, `Done ${marker}`, "utf8");
        await fs.writeFile(path.join(workspacePath, "generated.ts"), `export const value = "${marker}";\n`, "utf8");
        return {
          code: 0,
          signal: null,
          durationMs: 1,
          stdoutText: [
            JSON.stringify({ type: "error", message: marker }),
            JSON.stringify({ type: "shell.command", command: marker }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, extra: marker } }),
          ].join("\n"),
          stderrText: marker,
        };
      },
    });
    const scenario = payload.scenarios[0];
    assert.equal(scenario.status, "completed");
    assert.equal(scenario.workspacePath, null);
    assert.equal(scenario.finalMessagePath, null);
    assert.equal(scenario.rawEventLogPath, null);
    assert.equal(payload.codexVersion, "unknown");
    const saved = [
      JSON.stringify(payload),
      await fs.readFile(payload.resultPath, "utf8"),
      await fs.readFile(payload.usageLogPath, "utf8"),
      await fs.readFile(scenario.diagnosticsPath, "utf8"),
      renderPayload(payload, "markdown"),
    ];
    assert.equal(saved.some((value) => value.includes(marker)), false, "credential text must not be persisted");
    const diagnostics = JSON.parse(saved[3]);
    assert.equal(diagnostics.rawOutputRetained, false);
    assert.ok(diagnostics.stdoutBytes > 0);
    assert.equal(diagnostics.telemetry.usage.total_tokens, 8);
    const files = await fs.readdir(path.dirname(scenario.diagnosticsPath));
    assert.equal(files.some((name) => /stdout|stderr|final-message/.test(name)), false);
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE;
    else process.env.PLUGIN_EVAL_CODEX_HOME_SOURCE = previous;
  }
});

test("generated command paths quote shell metacharacters", () => {
  const formatted = formatCommandPath(path.join(os.tmpdir(), "skill name;$(touch marker)"), { cwd: os.tmpdir(), homeDir: path.join(os.tmpdir(), "other-home") });
  assert.equal(formatted, "'skill name;$(touch marker)'");
});

test("Windows generated commands execute safely in Command Prompt", { skip: process.platform !== "win32" }, async () => {
  const tempDir = await makeTempDir("plugin-eval-cmd-quote");
  const targetName = "skill & echo INJECTED %PLUGIN_EVAL_MISSING%!PLUGIN_EVAL_MISSING!'";
  const requests = [
    'say "hello" & echo INJECTED %PLUGIN_EVAL_MISSING%!PLUGIN_EVAL_MISSING!',
    'first line\nsecond line with \\"quotes\\" and $() ; | echo INJECTED',
  ];
  for (const request of requests) {
    const command = formatGeneratedCommand(
      `node -e ${quoteCommandArgument("process.stdout.write(JSON.stringify(process.argv.slice(1)))")} ${formatCommandPath(path.join(tempDir, targetName), { cwd: tempDir, homeDir: path.join(tempDir, "other-home") })} ${quoteCommandArgument(request)}`,
    );
    for (const delayedExpansion of ["off", "on"]) {
      const { stdout } = await execFileAsync("cmd.exe", ["/d", `/v:${delayedExpansion}`, "/c", command], {
        cwd: tempDir,
        windowsVerbatimArguments: true,
      });
      assert.deepEqual(JSON.parse(stdout), [targetName, request]);
    }
  }

  const skillPath = path.join(tempDir, targetName);
  await writeSkillFixture(skillPath, { description: "Command Prompt fixture", bodyLines: 2 });
  const startCommand = formatGeneratedCommand(
    `plugin-eval start ${formatCommandPath(skillPath, { cwd: tempDir, homeDir: path.join(tempDir, "other-home") })} --request ${quoteCommandArgument(requests[0])} --format json`,
  );
  const { stdout } = await execFileAsync("cmd.exe", ["/d", "/v:on", "/c", startCommand], {
    cwd: tempDir,
    windowsVerbatimArguments: true,
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.target.path, skillPath);
  assert.equal(payload.requestedChatPrompt, requests[0]);
});

test("crafted broken links cannot inject markdown report headings", async () => {
  const tempDir = await makeTempDir("plugin-eval-markdown-link");
  await writeSkillFixture(tempDir, { description: "Fixture", bodyLines: 2 });
  await fs.appendFile(path.join(tempDir, "SKILL.md"), "\n[link](missing\n# Injected heading)\n", "utf8");
  const result = await analyzePath(tempDir);
  const markdown = renderPayload(result, "markdown");
  assert.ok(result.checks.some((check) => check.id === "broken-relative-links"));
  assert.doesNotMatch(markdown, /^# Injected heading/m);
});

test("generates improvement briefs and comparison payloads", async () => {
  const goodPath = path.join(fixturesRoot, "minimal-skill");
  const badDir = await makeTempDir("plugin-eval-compare");
  await writeSkillFixture(badDir, {
    description: `Verbose description ${"y".repeat(1300)}`,
    bodyLines: 650,
  });

  const before = await analyzePath(badDir);
  const after = await analyzePath(goodPath);
  const diff = compareResults(before, after);

  assert.match(after.improvementBrief.suggestedPrompt, /skill-creator/i);
  assert.ok(diff.scoreDelta > 0);
  assert.ok(diff.resolvedFailures.length >= 1);
});

test("summary includes deductions, category totals, and risk reasons", async () => {
  const tempDir = await makeTempDir("plugin-eval-summary");
  await writeSkillFixture(tempDir, {
    description: `Verbose description ${"z".repeat(1300)}`,
    bodyLines: 650,
  });

  const result = await analyzePath(tempDir);

  assert.ok(result.summary.scoreBreakdown.totalDeductions > 0);
  assert.ok(result.summary.deductions.length > 0);
  assert.ok(result.summary.categoryDeductions.length > 0);
  assert.ok(result.summary.riskReasons.length > 0);
  assert.equal(result.summary.scoreBreakdown.finalScore, result.summary.score);
});

test("CLI analyze, report, compare, and explain-budget commands work together", async () => {
  const tempDir = await makeTempDir("plugin-eval-cli");
  const resultPath = path.join(tempDir, "result.json");
  const markdownPath = path.join(tempDir, "result.md");
  const comparePath = path.join(tempDir, "compare.md");
  const briefPath = path.join(tempDir, "brief.json");
  const measuresPath = path.join(tempDir, "measures.md");
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const usagePath = path.join(fixturesRoot, "observed-usage", "responses.jsonl");

  await execFileAsync(
    nodeBin,
    [cliPath, "analyze", skillPath, "--output", resultPath, "--brief-out", briefPath, "--observed-usage", usagePath],
    {
      cwd: repoRoot,
    },
  );
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  assert.equal(result.target.kind, "skill");
  assert.ok(await fs.stat(briefPath));
  assert.equal(result.observedUsage.sampleCount, 3);

  await execFileAsync(nodeBin, [cliPath, "report", resultPath, "--format", "markdown", "--output", markdownPath], {
    cwd: repoRoot,
  });
  assert.match(await fs.readFile(markdownPath, "utf8"), /Plugin Eval Report/);
  assert.match(await fs.readFile(markdownPath, "utf8"), /Recommended Next Step/);

  await execFileAsync(nodeBin, [cliPath, "compare", resultPath, resultPath, "--format", "markdown", "--output", comparePath], {
    cwd: repoRoot,
  });
  assert.match(await fs.readFile(comparePath, "utf8"), /Plugin Eval Comparison/);
  assert.match(await fs.readFile(comparePath, "utf8"), /Recommended Next Step/);

  const { stdout } = await execFileAsync(nodeBin, [cliPath, "explain-budget", skillPath], {
    cwd: repoRoot,
  });
  const budgetPayload = JSON.parse(stdout);
  assert.equal(budgetPayload.kind, "budget-explanation");
  assert.ok(budgetPayload.nextAction);

  await execFileAsync(
    nodeBin,
    [cliPath, "measurement-plan", skillPath, "--format", "markdown", "--output", measuresPath, "--observed-usage", usagePath],
    {
      cwd: repoRoot,
    },
  );
  assert.match(await fs.readFile(measuresPath, "utf8"), /Measurement Plan/);
  assert.match(await fs.readFile(measuresPath, "utf8"), /Recommended Next Step/);
  assert.match(await fs.readFile(measuresPath, "utf8"), /<details>/);
});

test("CLI init-benchmark and benchmark commands work together with a fake codex executable", async () => {
  const sourcePath = path.join(fixturesRoot, "minimal-skill");
  const tempDir = await makeTempDir("plugin-eval-cli-benchmark");
  const skillPath = path.join(tempDir, "minimal-skill");
  const fakeCodexPath = await createFakeCodexExecutable(tempDir);
  const initPath = path.join(tempDir, "init.md");
  const runPath = path.join(tempDir, "run.md");
  await copyDirectory(sourcePath, skillPath);

  await execFileAsync(
    nodeBin,
    [cliPath, "init-benchmark", skillPath, "--format", "markdown", "--output", path.join(skillPath, ".plugin-eval", "benchmark.json")],
    {
      cwd: repoRoot,
    },
  );

  const { stdout } = await execFileAsync(
    nodeBin,
    [cliPath, "init-benchmark", skillPath, "--format", "markdown"],
    {
      cwd: repoRoot,
    },
  );
  await fs.writeFile(initPath, stdout, "utf8");
  assert.match(await fs.readFile(initPath, "utf8"), /Benchmark Template Ready/);
  assert.match(await fs.readFile(initPath, "utf8"), /Use From Codex Chat/);

  const configPath = path.join(skillPath, ".plugin-eval", "benchmark.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.verifiers.files = ["generated.ts"];
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const run = await execFileAsync(
    nodeBin,
    [cliPath, "benchmark", skillPath, "--config", configPath, "--workspace-source", repoRoot, "--workspace-include", "README.md", "--format", "markdown"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PLUGIN_EVAL_CODEX_EXECUTABLE: nodeBin,
        PLUGIN_EVAL_CODEX_EXECUTABLE_ARGS: JSON.stringify([fakeCodexPath]),
      },
    },
  );
  await fs.writeFile(runPath, run.stdout, "utf8");
  assert.match(await fs.readFile(runPath, "utf8"), /Benchmark Run/);
  assert.match(await fs.readFile(runPath, "utf8"), /Recommended Next Step/);
  assert.match(await fs.readFile(runPath, "utf8"), /Scenarios/);
  assert.match(await fs.readFile(runPath, "utf8"), /Codex version: codex-cli 0\.0\.0-test/);
  assert.match(await fs.readFile(runPath, "utf8"), /Created-file check \[passed\]/);
});

test("explainBudget returns a budget-only payload", async () => {
  const payload = await explainBudget(path.join(fixturesRoot, "minimal-skill"));

  assert.equal(payload.kind, "budget-explanation");
  assert.equal(payload.budgets.method, "estimated-static");
  assert.ok(payload.budgets.trigger_cost_tokens.value > 0);
  assert.ok(payload.workflowGuide);
});

test("workflow guide routes natural chat requests into the beginner-friendly path", async () => {
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const guide = await buildWorkflowGuide(skillPath, {
    request: "Measure the real token usage of this skill.",
  });
  const markdown = renderPayload(guide, "markdown");

  assert.equal(guide.kind, "workflow-guide");
  assert.equal(guide.recommendedWorkflowId, "measure");
  assert.equal(guide.requestRouting.goal, "measure");
  assert.ok(guide.nextAction);
  assert.match(markdown, /Plugin Eval Start Here/);
  assert.match(markdown, /Measure the real token usage of this skill\./);
  assert.match(decodedGeneratedCommand(guide.startHere.startCommand), /^plugin-eval start /);
  assert.ok(guide.entrypoints.some((entry) => entry.commands.some((command) => decodedGeneratedCommand(command).includes("plugin-eval init-benchmark"))));
  assert.ok(markdown.includes(`Quick local entrypoint: \`${guide.startHere.startCommand}\``));
});

test("workflow guide routes analysis requests into report plus benchmark setup", async () => {
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const guide = await buildWorkflowGuide(skillPath, {
    request: "give me an analysis of the game dev skill",
  });
  const markdown = renderPayload(guide, "markdown");

  assert.equal(guide.kind, "workflow-guide");
  assert.equal(guide.recommendedWorkflowId, "analysis");
  assert.equal(guide.requestRouting.goal, "analysis");
  assert.equal(decodedGeneratedCommand(guide.startHere.firstCommand), `plugin-eval analyze ${formatCommandPath(skillPath)} --format markdown`);
  assert.ok(guide.startHere.commands.some((command) => decodedGeneratedCommand(command).includes("plugin-eval init-benchmark")));
  assert.match(markdown, /Full Skill Analysis/);
  assert.ok(markdown.includes(guide.startHere.commands.find((command) => decodedGeneratedCommand(command).includes("plugin-eval init-benchmark"))));
});

test("CLI start command renders chat-first workflow suggestions", async () => {
  const skillPath = path.join(fixturesRoot, "minimal-skill");
  const { stdout } = await execFileAsync(
    nodeBin,
    [cliPath, "start", skillPath, "--request", "what should I run next?", "--format", "markdown"],
    {
      cwd: repoRoot,
    },
  );

  assert.match(stdout, /Plugin Eval Start Here/);
  assert.match(stdout, /What should I run next\?/i);
  if (process.platform === "win32") {
    assert.match(stdout, /powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  } else {
    assert.match(stdout, /plugin-eval start .*what should I run next/i);
    assert.match(stdout, /plugin-eval analyze/);
  }
  assert.match(stdout, /Recommended Next Step/);
});

test("shipped plugin surfaces advertise beginner chat prompts", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const umbrellaSkill = await fs.readFile(path.join(repoRoot, "skills", "plugin-eval", "SKILL.md"), "utf8");
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.match(manifest.interface.longDescription, /plugin-eval start/i);
  assert.deepEqual(manifest.interface.defaultPrompt, [
    "Give me an analysis of the game studio plugin.",
    "Evaluate this plugin.",
    "Why did this score that way?",
  ]);
  assert.match(umbrellaSkill, /plugin-eval start <path> --request/);
  assert.match(umbrellaSkill, /analysis of the game dev skill/i);
  assert.match(umbrellaSkill, /plugin-eval measurement-plan/);
  assert.match(umbrellaSkill, /What should I fix first\?/);
  assert.match(readme, /Start From Chat/);
  assert.match(readme, /plugin-eval start <path> --request/);
  assert.match(readme, /analysis of the game dev skill/i);
  assert.match(readme, /Why did this score that way\?/);
});
