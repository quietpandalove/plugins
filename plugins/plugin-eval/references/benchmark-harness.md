# Benchmark Harness

The benchmark harness gives `plugin-eval` a beginner-friendly path to measured usage.

## Goals

- help first-time skill authors collect real usage without building their own harness
- keep the workflow local-first and transparent
- produce usage logs that can be fed back into `plugin-eval analyze --observed-usage`

## Workflow

1. Run `plugin-eval init-benchmark <path>`.
2. Edit and review the generated `benchmark.json` so `workspace.sourcePath`, the scenarios, and `verifiers.files` match real tasks. File checks require new files created by the scenario; host command verifiers are disabled.
3. Run the benchmark with `plugin-eval benchmark <path> --config <file> --workspace-source <directory>`; the source must match the config. The workspace starts empty. Add only exact required source files with repeated `--workspace-include <relative-file>` and additional target files with repeated `--target-include <relative-file>`.
4. Feed the usage log into `plugin-eval analyze` when usage telemetry is available.

## Design Choices

- The generated benchmark file is meant to be edited by humans.
- Scenarios use plain-language fields such as `title`, `purpose`, `userInput`, and `successChecklist`.
- Benchmarking means real `codex exec` runs, not simulated single-turn Responses API requests.
- Benchmark temp homes do not receive the default user `~/.codex/auth.json`; set `PLUGIN_EVAL_CODEX_HOME_SOURCE` to a scoped Codex home to opt in to copying test credentials.
- Each benchmark run saves structured status, count, and usage diagnostics under `.plugin-eval/runs/<timestamp>/`. Raw child output and final-message text are not retained because they may contain credentials.
- Coverage artifacts, including those under `dist/`, are limited to 64 MiB per file and 256 MiB total before parsing; exceeding either limit fails the run with a resource-limit diagnostic.
- Windows-generated local commands invoke PowerShell with encoded arguments and can be pasted into Command Prompt or PowerShell. POSIX-generated commands retain normal shell quoting.
- When token usage is emitted by Codex, the benchmark also writes JSONL usage logs in a shape that `--observed-usage` already understands.

## Commands

```bash
plugin-eval init-benchmark ./skills/my-skill
plugin-eval benchmark ./skills/my-skill --config ./skills/my-skill/.plugin-eval/benchmark.json --workspace-source ./test-workspace
plugin-eval analyze ./skills/my-skill --observed-usage ./skills/my-skill/.plugin-eval/benchmark-usage.jsonl --format markdown
```
