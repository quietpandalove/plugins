import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

import { BenchmarkResourceLimitError } from "../core/benchmark-workspace.js";
import { createArtifact, createCheck, createMetric } from "../core/schema.js";
import { relativePath } from "../lib/files.js";

const MAX_COVERAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_COVERAGE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_COVERAGE_ENTRIES = 20000;
const MAX_COVERAGE_FILES = 10000;
const MAX_LCOV_LINE_BYTES = 1024 * 1024;
const MAX_LCOV_LINES = 1000000;

async function findCoverageFiles(rootPath) {
  const results = [];
  const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
  let entryCount = 0;

  async function visit(currentPath) {
    for await (const entry of await fs.opendir(currentPath)) {
      entryCount += 1;
      if (entryCount > MAX_COVERAGE_ENTRIES) {
        throw new BenchmarkResourceLimitError("coverage entry count", MAX_COVERAGE_ENTRIES, entryCount, "entries");
      }
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) {
          continue;
        }
        await visit(entryPath);
        continue;
      }
      if (
        entry.isFile() &&
        ["lcov.info", "coverage.xml", "coverage-final.json", "coverage-summary.json"].includes(entry.name)
      ) {
        if (results.length >= MAX_COVERAGE_FILES) {
          throw new BenchmarkResourceLimitError("coverage file count", MAX_COVERAGE_FILES, results.length + 1, "files");
        }
        results.push(entryPath);
      }
    }
  }

  await visit(rootPath);
  return results.sort();
}

async function* readCoverageChunks(filePath, state) {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_COVERAGE_FILE_BYTES) {
    throw new BenchmarkResourceLimitError("coverage file", MAX_COVERAGE_FILE_BYTES, stats.size);
  }
  if (state.totalBytes + stats.size > MAX_COVERAGE_TOTAL_BYTES) {
    throw new BenchmarkResourceLimitError("coverage total", MAX_COVERAGE_TOTAL_BYTES, state.totalBytes + stats.size);
  }

  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > MAX_COVERAGE_FILE_BYTES) {
      throw new BenchmarkResourceLimitError("coverage file", MAX_COVERAGE_FILE_BYTES, bytes);
    }
    if (state.totalBytes + bytes > MAX_COVERAGE_TOTAL_BYTES) {
      throw new BenchmarkResourceLimitError("coverage total", MAX_COVERAGE_TOTAL_BYTES, state.totalBytes + bytes);
    }
    yield chunk;
  }
  state.totalBytes += bytes;
}

async function readCoverageText(filePath, state) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of readCoverageChunks(filePath, state)) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function parseLcov(filePath, state) {
  let found = 0;
  let hit = 0;
  let lines = 0;
  let fragments = [];
  let lineBytes = 0;

  function addFragment(fragment) {
    lineBytes += fragment.length;
    if (lineBytes > MAX_LCOV_LINE_BYTES) {
      throw new BenchmarkResourceLimitError("coverage LCOV line", MAX_LCOV_LINE_BYTES, lineBytes);
    }
    if (fragment.length > 0) fragments.push(fragment);
  }

  function finishLine() {
    lines += 1;
    if (lines > MAX_LCOV_LINES) {
      throw new BenchmarkResourceLimitError("coverage LCOV line count", MAX_LCOV_LINES, lines, "lines");
    }
    if (lineBytes > 3) {
      const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, lineBytes);
      if (line[0] === 76 && line[1] === 70 && line[2] === 58) {
        found += Number(line.subarray(3).toString("utf8"));
      } else if (line[0] === 76 && line[1] === 72 && line[2] === 58) {
        hit += Number(line.subarray(3).toString("utf8"));
      }
    }
    fragments.length = 0;
    lineBytes = 0;
  }

  for await (const chunk of readCoverageChunks(filePath, state)) {
    let start = 0;
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      if (end > start) addFragment(chunk.subarray(start, end));
      finishLine();
      start = end + 1;
    }
    if (start < chunk.length) addFragment(chunk.subarray(start));
  }
  if (lineBytes > 0) finishLine();
  return found > 0 ? Number(((hit / found) * 100).toFixed(2)) : null;
}

function parseCoverageXml(text) {
  const lineRateMatch = /line-rate="([^"]+)"/.exec(text);
  if (lineRateMatch) {
    return Number((Number(lineRateMatch[1]) * 100).toFixed(2));
  }
  const coveredMatch = /lines-covered="([^"]+)"/.exec(text);
  const validMatch = /lines-valid="([^"]+)"/.exec(text);
  if (coveredMatch && validMatch && Number(validMatch[1]) > 0) {
    return Number(((Number(coveredMatch[1]) / Number(validMatch[1])) * 100).toFixed(2));
  }
  return null;
}

function parseCoverageJson(text) {
  const payload = JSON.parse(text);
  if (payload.total?.lines?.pct != null) {
    return Number(payload.total.lines.pct);
  }

  const fileEntries = Object.values(payload).filter((value) => value && typeof value === "object" && value.s);
  let totalStatements = 0;
  let coveredStatements = 0;
  for (const entry of fileEntries) {
    for (const count of Object.values(entry.s)) {
      totalStatements += 1;
      if (Number(count) > 0) {
        coveredStatements += 1;
      }
    }
  }
  if (totalStatements === 0) {
    return null;
  }
  return Number(((coveredStatements / totalStatements) * 100).toFixed(2));
}

async function parseCoverageFile(filePath, state) {
  if (filePath.endsWith("lcov.info")) {
    return parseLcov(filePath, state);
  }
  const text = await readCoverageText(filePath, state);
  if (filePath.endsWith("coverage.xml")) {
    return parseCoverageXml(text);
  }
  if (filePath.endsWith(".json")) {
    return parseCoverageJson(text);
  }
  return null;
}

export async function analyzeCoverageArtifacts(rootPath) {
  const checks = [];
  const metrics = [];
  const artifacts = [];
  const coverageFiles = await findCoverageFiles(rootPath);

  metrics.push(
    createMetric({
      id: "coverage_artifact_count",
      category: "coverage",
      value: coverageFiles.length,
      unit: "files",
      band: coverageFiles.length > 0 ? "good" : "info",
    }),
  );

  if (coverageFiles.length === 0) {
    checks.push(
      createCheck({
        id: "coverage-artifacts-unavailable",
        category: "coverage",
        severity: "info",
        status: "info",
        message: "No coverage artifacts were found for this target.",
        evidence: [relativePath(process.cwd(), rootPath)],
        remediation: ["Generate `lcov.info`, `coverage.xml`, or an Istanbul coverage JSON file if you want coverage scoring."],
      }),
    );
    return { checks, metrics, artifacts };
  }

  const fileSummaries = [];
  const readState = { totalBytes: 0 };
  for (const filePath of coverageFiles) {
    const coverage = await parseCoverageFile(filePath, readState);
    if (coverage != null) {
      fileSummaries.push({
        path: relativePath(rootPath, filePath),
        coverage,
      });
    }
  }

  if (fileSummaries.length > 0) {
    const bestCoverage = Math.max(...fileSummaries.map((item) => item.coverage));
    metrics.push(
      createMetric({
        id: "coverage_percent",
        category: "coverage",
        value: bestCoverage,
        unit: "percent",
        band: bestCoverage >= 85 ? "good" : bestCoverage >= 70 ? "moderate" : "heavy",
      }),
    );
    if (bestCoverage < 70) {
      checks.push(
        createCheck({
          id: "coverage-low",
          category: "coverage",
          severity: "warning",
          status: "warn",
          message: "Coverage artifacts were found, but the measured coverage is low.",
          evidence: fileSummaries.map((item) => `${item.path}: ${item.coverage}%`),
          remediation: ["Increase test coverage on the code that carries the most complexity or risk."],
        }),
      );
    }
  }

  artifacts.push(
    createArtifact({
      id: "coverage-artifacts",
      type: "coverage",
      label: "Coverage artifacts",
      description: "Coverage files discovered during evaluation.",
      data: {
        files: fileSummaries,
      },
    }),
  );

  return { checks, metrics, artifacts };
}
