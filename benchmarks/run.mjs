#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "..");
const manifest = JSON.parse(await readFile(join(benchmarkRoot, "task-manifest.json"), "utf8"));
const manifestHash = await sha256File(join(benchmarkRoot, "task-manifest.json"));
const runnerHash = await sha256File(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2));
const inheritedPath = process.env.PATH ?? "";
const rtkProbe = spawnSync("sh", ["-c", "command -v rtk"], { encoding: "utf8", env: process.env });
const rtkExecutable = rtkProbe.status === 0 ? rtkProbe.stdout.trim() : null;
if (rtkExecutable) {
  throw new Error(`formal benchmark refuses inherited RTK executable: ${rtkExecutable}`);
}
const binary = resolve(options.binary ?? join(repositoryRoot, ".build", "debug", "aishell-mcp"));
const resultsDirectory = join(benchmarkRoot, "results");
await mkdir(resultsDirectory, { recursive: true });

const selectedTasks = options.task === "all"
  ? manifest.tasks.filter((task) => task.category === "sentinel")
  : manifest.tasks.filter((task) => task.id === options.task);
if (selectedTasks.length === 0) throw new Error(`unknown task: ${options.task}`);
const arms = options.arm === "both" ? ["native", "aishell"] : [options.arm];
const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
const binaryHash = options.arm === "native" ? null : await sha256File(binary);
const repositoryCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot, encoding: "utf8"
}).stdout.trim();
const repositoryStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: repositoryRoot, encoding: "utf8"
}).stdout;
const repositoryStatusHash = sha256Text(repositoryStatus);
const toolCatalogHash = arms.includes("aishell") ? await hashToolCatalog(binary) : null;
const records = [];

for (const task of selectedTasks) {
  for (const arm of arms) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      const record = await runOnce({ task, arm, repetition });
      records.push(record);
      process.stdout.write(`${record.taskId} ${record.arm} #${repetition}: oracle=${record.oracle.success} tokens=${record.usage.totalTokens ?? "n/a"} wall=${record.timing.wallMilliseconds}ms\n`);
    }
  }
}

const report = aggregate(records);
const reportPath = options.reportPath
  ? resolve(repositoryRoot, options.reportPath)
  : join(resultsDirectory, `report-${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(`report: ${reportPath}\n`);

async function runOnce({ task, arm, repetition }) {
  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}-${task.id}-${arm}-${repetition}`;
  const workRoot = await mkdtemp(join(tmpdir(), "aishell-bench-"));
  const workspaceCandidate = join(workRoot, basename(task.fixture));
  const stateDirectory = join(workRoot, "state");
  try {
    await cp(join(benchmarkRoot, task.fixture), workspaceCandidate, { recursive: true });
    const workspace = await realpath(workspaceCandidate);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "runtime.json"), JSON.stringify({
      allowedRootPaths: [workspace],
      isPaused: false,
      updatedAt: new Date().toISOString()
    }, null, 2) + "\n");

    const fixtureHash = await hashDirectory(workspace);
    const args = [
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--color", "never", "--dangerously-bypass-approvals-and-sandbox",
      "--config", `model_reasoning_effort=${tomlString(options.reasoningEffort)}`,
      "--cd", workspace
    ];
    if (options.model) args.push("--model", options.model);
    if (arm === "aishell") {
      args.push("--config", `mcp_servers.aishell.command=${tomlString(binary)}`);
      args.push("--config", `mcp_servers.aishell.env={ AISHELL_STATE_DIRECTORY = ${tomlString(stateDirectory)}, AISHELL_TOOL_PROFILE = "development" }`);
    }
    const prompt = `${manifest.commonPrompt}\n\n${task.prompt}`;
    args.push(prompt);
    const configManifest = {
      sandbox: "danger-full-access",
      approvalPolicy: "bypass",
      timeoutMilliseconds: options.timeoutMilliseconds,
      ephemeral: true,
      ignoreUserConfig: true,
      ignoreRules: true,
      toolProfile: arm === "aishell" ? "development" : "native"
    };

    const started = performance.now();
    const execution = await runProcess("codex", args, workspace, options.timeoutMilliseconds);
    const wallMilliseconds = Math.round(performance.now() - started);
    const events = execution.stdout.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { type: "unparsed", line }; }
    });
    const usage = extractUsage(events);
    const completedAIShellTools = listCompletedAIShellTools(events);
    const oracleResult = spawnSync(task.oracle[0], task.oracle.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000
    });
    const requiredTools = arm === "aishell" ? (task.requiredAIShellTools ?? []) : [];
    const toolOracleSuccess = requiredTools.every((name) => completedAIShellTools.includes(name));
    const agentSuccess = execution.exitCode === 0 && !execution.timedOut;
    const record = {
      schemaVersion: "aishell.benchmark-run.v1",
      runId,
      taskId: task.id,
      arm,
      repetition,
      environment: {
        codexVersion,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        fixtureHash,
        toolProfile: arm === "aishell" ? "development" : "native",
        aishellBinaryHash: arm === "aishell" ? binaryHash : null
      },
      provenance: {
        promptHash: sha256Text(prompt),
        manifestHash,
        runnerHash,
        repositoryCommit,
        repositoryDirty: repositoryStatus.length > 0,
        repositoryStatusHash,
        pathHash: sha256Text(inheritedPath),
        rtkExecutable,
        toolCatalogHash: arm === "aishell" ? toolCatalogHash : null,
        configHash: sha256Text(JSON.stringify(configManifest)),
        ...configManifest
      },
      usage,
      oracle: {
        success: oracleResult.status === 0 && toolOracleSuccess && agentSuccess,
        exitCode: oracleResult.status,
        requiredTools,
        completedAIShellTools,
        stdoutBytes: Buffer.byteLength(oracleResult.stdout ?? ""),
        stderrBytes: Buffer.byteLength(oracleResult.stderr ?? "")
      },
      timing: { wallMilliseconds },
      agent: {
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        stderrBytes: Buffer.byteLength(execution.stderr),
        eventCount: events.length,
        aishellToolCalls: countAIShellToolCalls(events)
      }
    };
    await writeFile(join(resultsDirectory, `${runId}.json`), JSON.stringify(record, null, 2) + "\n");
    await writeFile(join(resultsDirectory, `${runId}.events.jsonl`), execution.stdout);
    await writeFile(join(resultsDirectory, `${runId}.stderr.log`), execution.stderr);
    return record;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function parseArguments(arguments_) {
  const result = {
    arm: "both",
    task: "all",
    repetitions: 1,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    binary: null,
    reportPath: null,
    timeoutMilliseconds: 600_000
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--arm") result.arm = value;
    else if (argument === "--task") result.task = value;
    else if (argument === "--repetitions") result.repetitions = Number(value);
    else if (argument === "--model") result.model = value;
    else if (argument === "--reasoning-effort") result.reasoningEffort = value;
    else if (argument === "--binary") result.binary = value;
    else if (argument === "--timeout-seconds") result.timeoutMilliseconds = Number(value) * 1_000;
    else if (argument === "--report-path") result.reportPath = value;
    else if (argument === "--help") {
      process.stdout.write("node benchmarks/run.mjs [--arm native|aishell|both] [--task id|all] [--repetitions N] [--model MODEL] [--reasoning-effort LEVEL] [--binary PATH] [--timeout-seconds N] [--report-path PATH]\n");
      process.exit(0);
    } else continue;
    index += 1;
  }
  if (!["native", "aishell", "both"].includes(result.arm)) throw new Error("invalid --arm");
  if (!Number.isInteger(result.repetitions) || result.repetitions < 1) throw new Error("invalid --repetitions");
  return result;
}

function runProcess(command, args, cwd, timeoutMilliseconds) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMilliseconds);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, timedOut });
    });
  });
}

function extractUsage(events) {
  let found = null;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.usage && typeof value.usage === "object") found = value.usage;
    for (const child of Object.values(value)) visit(child);
  };
  for (const event of events) visit(event);
  const inputTokens = integer(found?.input_tokens ?? found?.inputTokens);
  const cachedInputTokens = integer(found?.cached_input_tokens ?? found?.cachedInputTokens);
  const outputTokens = integer(found?.output_tokens ?? found?.outputTokens);
  const totalTokens = integer(found?.total_tokens ?? found?.totalTokens)
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens, available: totalTokens !== null };
}

function countAIShellToolCalls(events) {
  return listCompletedAIShellTools(events).length;
}

function listCompletedAIShellTools(events) {
  const names = new Set(["run_check", "artifact_read", "workspace_snapshot", "read_context", "search_context"]);
  const completed = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const name = value.name ?? value.tool_name ?? value.tool;
    const result = value.result;
    const toolSucceeded = value.status === "completed"
      && value.error == null
      && result != null
      && result.isError !== true
      && result.is_error !== true;
    if (toolSucceeded && names.has(name)) completed.push(name);
    Object.values(value).forEach(visit);
  };
  events.forEach(visit);
  return completed;
}

function aggregate(records) {
  const arms = {};
  for (const record of records) {
    const bucket = arms[record.arm] ??= { attempts: 0, successes: 0, totalTokens: 0, tokenRecords: 0, wallMilliseconds: 0 };
    bucket.attempts += 1;
    bucket.successes += record.oracle.success ? 1 : 0;
    bucket.wallMilliseconds += record.timing.wallMilliseconds;
    if (record.usage.totalTokens !== null) {
      bucket.totalTokens += record.usage.totalTokens;
      bucket.tokenRecords += 1;
    }
  }
  for (const [arm, bucket] of Object.entries(arms)) {
    bucket.tokensPerSolvedTask = bucket.successes > 0 && bucket.tokenRecords === bucket.attempts
      ? bucket.totalTokens / bucket.successes : null;
    bucket.meanWallMilliseconds = bucket.attempts > 0 ? bucket.wallMilliseconds / bucket.attempts : null;
    const wallValues = records.filter((record) => record.arm === arm).map((record) => record.timing.wallMilliseconds);
    bucket.p50WallMilliseconds = quantile(wallValues, 0.5);
    bucket.p95WallMilliseconds = quantile(wallValues, 0.95);
  }
  return {
    schemaVersion: "aishell.benchmark-report.v1",
    generatedAt: new Date().toISOString(),
    formula: manifest.primaryMetric,
    arms,
    records: records.map(({ runId, taskId, arm, repetition, environment, provenance, oracle, usage, timing, agent }) => ({
      runId, taskId, arm, repetition, environment, provenance, oracle, usage, timing, agent
    }))
  };
}

async function hashDirectory(directory) {
  const hash = createHash("sha256");
  async function walk(current) {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const path = join(current, name);
      const info = await stat(path);
      const relative = path.slice(directory.length + 1);
      hash.update(relative + "\0");
      if (info.isDirectory()) await walk(path);
      else hash.update(await readFile(path));
    }
  }
  await walk(directory);
  return hash.digest("hex");
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashToolCatalog(executable) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "aishell-catalog-"));
  try {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "benchmark", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
    const result = spawnSync(executable, [], {
      input,
      encoding: "utf8",
      env: { ...process.env, AISHELL_STATE_DIRECTORY: stateDirectory, AISHELL_TOOL_PROFILE: "development" }
    });
    if (result.status !== 0) throw new Error(`tools/list probe failed: ${result.stderr}`);
    const response = result.stdout.split("\n").filter(Boolean).map(JSON.parse)
      .find((value) => value.id === 2);
    if (!response?.result?.tools) throw new Error("tools/list probe returned no catalog");
    return sha256Text(JSON.stringify(response.result.tools));
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
