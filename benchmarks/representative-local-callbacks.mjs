#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  captureTrustedSetup as capturePhase3TrustedSetup,
  collectAttemptEvidence as collectPhase3AttemptEvidence,
  exchangeMCP,
  localToolAction,
  observedToolCalls,
  observerMetrics,
  observeProviderModel,
  representativeTelemetryEvidence,
  runProcess,
  runSetupStep as runPhase3SetupStep,
} from './phase3-local-callbacks.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';
import { canonicalJSONBytes } from './production-v2-benchmark-adapter.mjs';
import { REPRESENTATIVE_OPAQUE_BINDINGS_TOKEN } from './render-representative-prompt.mjs';

const PHASE3_TASKS = new Set([
  'freshness-cache-repeat-check', 'freshness-cache-input-change',
  'change-impact-direct-dependent', 'change-impact-unresolved-edge',
  'focused-pipeline-recommend-only', 'focused-pipeline-explicit-run',
]);
const TERMINAL_STATES = new Set(['passed', 'failed', 'timed_out', 'cancelled', 'interrupted']);
const EXECUTION = JSON.parse(await readFile(new URL('representative-execution-contracts.v1.json', import.meta.url), 'utf8'));
const SUITE = JSON.parse(await readFile(new URL('representative-suite.v1.json', import.meta.url), 'utf8'));
const CATALOG = JSON.parse(await readFile(new URL('capability-fixtures.v1.json', import.meta.url), 'utf8'));

export function selectRepresentativeCapabilityCall(candidates, expectedError = undefined) {
  if (!Array.isArray(candidates)) throw new TypeError('candidate calls must be an array');
  return expectedError
    ? candidates.find(({ isError, result }) => isError && result?.error?.code === expectedError) ?? null
    : candidates.find(({ isError }) => !isError) ?? null;
}

export function materializeRepresentativePrompt({ attempt, prompt, setup }) {
  if (!prompt.includes(REPRESENTATIVE_OPAQUE_BINDINGS_TOKEN)) return prompt;
  let bindings;
  if (attempt.taskID.startsWith('artifact-query-')) {
    const runs = setup.trustedProductionSetup.artifact_read?.managedRuns ?? [];
    bindings = attempt.arm === 'candidate'
      ? { baseline_run_id: runs[0]?.runID, candidate_run_id: runs[1]?.runID }
      : { baseline_run_id: 'run-1', candidate_run_id: 'run-2' };
  } else {
    bindings = { cursor: setup.fields.cursor };
  }
  if (Object.values(bindings).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`opaque setup bindings are unavailable: ${attempt.attemptID}`);
  }
  return prompt.replace(REPRESENTATIVE_OPAQUE_BINDINGS_TOKEN, JSON.stringify(bindings));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactBinding(value) {
  const bytes = canonicalJSONBytes(value);
  return { encoding: 'base64', base64: bytes.toString('base64'), byteLength: bytes.length, sha256: sha256(bytes) };
}

function successful(calls, tool) {
  return calls.filter((call) => call.tool === tool && !call.isError);
}

function terminalProcessEvidence(calls, execution) {
  const runResults = successful(calls, 'run_check').map(({ result }) => result);
  const observations = successful(calls, 'run_observe').map(({ result }) => result);
  const statuses = [...runResults, ...observations.map(({ status }) => status).filter(Boolean)];
  const terminal = statuses.reverse().find((status) => TERMINAL_STATES.has(status.state ?? status.status)) ?? {};
  const chunks = observations.flatMap(({ chunks }) => chunks ?? []);
  const diagnostic = chunks.map(({ text }) => text).find((text) => typeof text === 'string' && text.includes('first failure'));
  const cancelled = (terminal.state ?? terminal.status) === 'cancelled';
  return {
    agentExitCode: execution.exitCode,
    agentTimedOut: execution.timedOut,
    executedChecks: runResults.reduce((sum, result) => sum + (result.processesStarted ?? 0), 0),
    firstDiagnostic: diagnostic?.includes('first failure') ? 'first failure' : undefined,
    terminalExitCode: terminal.exitCode ?? terminal.exit_code,
    cancelAcknowledged: cancelled || observations.some((result) => result.cancelAcknowledged === true),
    terminalState: terminal.state ?? terminal.status,
    orphanProcesses: cancelled ? 0 : undefined,
  };
}

function continuationEvidence(calls, setup) {
  const pages = calls.filter(({ tool, isError }) => !isError && ['read_context', 'search_context'].includes(tool))
    .map(({ result }) => ({ items: [
      ...(result.matches ?? []).map(({ path: itemPath }) => itemPath).filter(Boolean),
      ...(result.chunks ?? []).map(({ path: itemPath }) => itemPath).filter(Boolean),
    ] }));
  const semantic = calls.find(({ tool, request, isError }) => tool === 'search_context' && request.action === 'semantic' && !isError)?.result;
  return {
    pages,
    indexCursor: setup.cursor ?? null,
    currentCursor: semantic?.freshness?.workspaceCursor ?? setup.cursor ?? null,
  };
}

function projectedCandidateResult(call, expectedSchema, finalAgent, expectedError) {
  if (expectedError) {
    const error = call.result.error ?? { code: expectedError };
    return { schemaVersion: 'aishell.error.v1', error };
  }
  return { ...call.result, ...finalAgent.assertions, schemaVersion: expectedSchema };
}

export async function collectRepresentativeAttemptEvidence(input) {
  if (PHASE3_TASKS.has(input.attempt.taskID)) return collectPhase3AttemptEvidence(input);
  const { attempt, workspace, preAttemptManifest, baselineManifest, benchmarkSetupEvidence,
    agentEvents, finalAgent, execution, mcpWireDirectory, artifactStore } = input;
  const calls = await observedToolCalls(agentEvents, mcpWireDirectory);
  const contract = materializeRequestContract({
    taskId: attempt.taskID, workspaceRoot: workspace, preAttemptManifest, baselineManifest,
    setupEvidence: benchmarkSetupEvidence, suite: SUITE, catalog: CATALOG, execution: EXECUTION,
  });
  const expectedError = EXECUTION.candidateExpectedErrorByTask[attempt.taskID];
  const events = [];
  const traceCalls = [];
  if (attempt.arm === 'candidate') {
    for (const required of contract.requiredCalls) {
      const candidates = calls.filter(({ tool }) => tool === required.tool);
      const call = selectRepresentativeCapabilityCall(candidates, expectedError);
      if (!call) continue;
      const result = projectedCandidateResult(
        call, EXECUTION.candidateResultSchemaByTool[required.tool], finalAgent, expectedError,
      );
      events.push({
        provider: 'aishell', tool: required.tool, action: required.action,
        request: required.requestSubset, metadata: { preStateDigest: preAttemptManifest.digest },
        result, resultDigest: sha256(canonicalJSONBytes(result)),
        status: expectedError ? 'failed' : 'succeeded', isError: Boolean(expectedError),
      });
      traceCalls.push({
        tool: required.tool, action: required.action,
        rawRequest: exactBinding(call.request), rawResult: exactBinding(call.result),
        projectedRequest: exactBinding(required.requestSubset), projectedResult: exactBinding(result),
      });
    }
  } else {
    for (const call of calls) {
      events.push({
        provider: call.provider, tool: call.tool, action: localToolAction(call), request: call.request,
        metadata: { preStateDigest: preAttemptManifest.digest }, result: call.result,
        resultDigest: sha256(canonicalJSONBytes(call.result)), status: call.status, isError: call.isError,
      });
    }
  }
  const result = attempt.arm === 'candidate'
    ? Object.assign({}, ...events.filter(({ isError }) => !isError).map(({ result: value }) => value),
      expectedError ? { errorCode: expectedError } : {})
    : { ...Object.assign({}, ...calls.filter(({ isError }) => !isError).map(({ result: value }) => value)), ...finalAgent.assertions };
  const adapterTraceBytes = attempt.arm === 'candidate' ? canonicalJSONBytes({
    schema: 'aishell.representative-candidate-adapter-trace.v1', attemptID: attempt.attemptID,
    taskID: attempt.taskID, preStateDigest: preAttemptManifest.digest, calls: traceCalls,
  }) : null;
  return {
    result,
    process: terminalProcessEvidence(calls, execution),
    artifactStore,
    telemetry: representativeTelemetryEvidence(calls, attempt),
    trace: continuationEvidence(calls, benchmarkSetupEvidence),
    toolTrace: { events },
    metrics: observerMetrics(agentEvents, calls, attempt),
    adapterTraceBytes,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safePath(root, relative) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`fixture path escapes root: ${relative}`);
  return target;
}

function collectProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
}

async function git(workspace, ...args) {
  return collectProcess('/usr/bin/git', args, workspace);
}

async function initializeGit(workspace) {
  await git(workspace, 'init', '-q', '-b', 'main');
  await git(workspace, 'config', 'user.name', 'AIShell Benchmark');
  await git(workspace, 'config', 'user.email', 'benchmark@example.invalid');
  await git(workspace, 'add', '-A');
  await git(workspace, 'commit', '-q', '-m', 'seed');
}

async function replaceRootIdentity(workspace) {
  const previous = `${workspace}.event-gap-source`;
  await rename(workspace, previous);
  await mkdir(workspace);
  for (const name of await readdir(previous)) {
    await cp(path.join(previous, name), path.join(workspace, name), { recursive: true, preserveTimestamps: true });
  }
  await rm(previous, { recursive: true, force: false });
}

class MCPClient {
  constructor({ binary, workspace, stateDirectory, expanded }) {
    this.nextID = 1;
    this.pending = new Map();
    this.stderr = '';
    this.process = spawn(binary, [], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AISHELL_STATE_DIRECTORY: stateDirectory,
        AISHELL_TOOL_PROFILE: 'development',
        ...(expanded ? { AISHELL_CAPABILITY_SET: 'expanded-v1' } : {}),
      },
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => { this.stderr += chunk; });
    let buffered = '';
    this.process.stdout.on('data', (chunk) => {
      buffered += chunk;
      while (buffered.includes('\n')) {
        const boundary = buffered.indexOf('\n');
        const line = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    });
    this.exit = new Promise((resolve) => this.process.once('exit', (code, signal) => resolve({ code, signal })));
  }

  request(method, params = undefined) {
    const id = this.nextID;
    this.nextID += 1;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'representative-setup', version: '1' },
    });
    if (response.error) throw new Error(`MCP initialize failed: ${response.error.message}`);
  }

  async call(name, args, { allowError = false } = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    const wrapper = response.result;
    if (!wrapper || typeof wrapper !== 'object' || typeof wrapper.isError !== 'boolean') {
      throw new Error(`${name}: invalid MCP result wrapper`);
    }
    if (wrapper.isError && !allowError) {
      throw new Error(`${name}: ${JSON.stringify(wrapper.structuredContent ?? wrapper.content)}`);
    }
    return { isError: wrapper.isError, result: wrapper.structuredContent };
  }

  async close() {
    this.process.stdin.end();
    const terminal = await this.exit;
    if (terminal.code !== 0) throw new Error(`setup MCP exited ${terminal.code}: ${this.stderr}`);
  }
}

function binaryFor(attempt, armBinaries) {
  return attempt.arm === 'native' ? null : armBinaries[attempt.arm];
}

async function withClient(attempt, armBinaries, workspace, stateDirectory, operation) {
  const binary = binaryFor(attempt, armBinaries);
  if (!binary) return null;
  const client = new MCPClient({
    binary, workspace, stateDirectory, expanded: attempt.arm === 'candidate',
  });
  try {
    await client.initialize();
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function fullSnapshot(attempt, armBinaries, workspace, stateDirectory, extra = {}) {
  return withClient(attempt, armBinaries, workspace, stateDirectory, async (client) => {
    const call = await client.call('workspace_snapshot', { path: workspace, context_budget: 0, ...extra });
    return call.result;
  });
}

async function terminalRun(client, start) {
  let status = start;
  const deadline = Date.now() + 30_000;
  while (!TERMINAL_STATES.has(status.state)) {
    if (Date.now() >= deadline) throw new Error(`setup managed run did not terminate: ${start.runID}`);
    const waited = await client.call('run_observe', {
      action: 'wait', run_handle: start.runHandle,
      after_state_revision: status.stateRevision, timeout_ms: 2_000,
    });
    status = waited.result.status;
  }
  return status;
}

async function createManagedArtifactRuns(attempt, armBinaries, workspace, stateDirectory, files) {
  if (attempt.arm !== 'candidate') return [];
  return withClient(attempt, armBinaries, workspace, stateDirectory, async (client) => {
    const output = [];
    for (const [index, file] of files.entries()) {
      const started = await client.call('run_check', {
        schema: 'aishell.run-check.v2',
        invocation: {
          mode: 'direct', executable: '/bin/cat', arguments: [file],
          working_directory: workspace, environment: {},
        },
        dispatch: { mode: 'start', client_run_key: `representative-artifact-${attempt.attemptID}-${index + 1}` },
        cache: 'off', execution_policy: { timeout_ms: 10_000, retention_seconds: 3_600 },
        selection: { binding: 'prepare' },
      });
      const terminal = await terminalRun(client, started.result);
      if (terminal.state !== 'passed') throw new Error(`artifact setup run failed: ${terminal.runID}`);
      output.push({ runID: terminal.runID, runHandle: terminal.runHandle, stdoutArtifact: terminal.stdoutArtifact });
    }
    return output;
  });
}

async function createBenchmarkArtifactStore(runDirectory, workspace, files) {
  const directory = path.join(runDirectory, 'benchmark-artifacts');
  await mkdir(directory);
  const artifacts = [];
  for (const [index, source] of files.entries()) {
    const bytes = await readFile(path.join(workspace, source));
    const handle = `art_benchmark_run_${index + 1}`;
    const file = `${handle}.data`;
    await writeFile(path.join(directory, file), bytes, { flag: 'wx' });
    artifacts.push({ handle, runId: `run-${index + 1}`, file, sha256: sha256(bytes) });
  }
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({
    schema: 'aishell.retained-artifact-manifest.v1', artifacts,
  }, null, 2)}\n`, { flag: 'wx' });
  return { directory, handles: artifacts.map(({ handle }) => handle) };
}

async function applySpecialMutation(workspace, mutation) {
  for (const item of mutation) {
    if (item.op === 'delayed-write' || item.op === 'inject-event-gap') continue;
    if (item.op === 'branch-write') {
      await git(workspace, 'switch', '-q', '-c', item.branch);
      await writeFile(safePath(workspace, item.path), item.content);
      await git(workspace, 'add', '-A');
      await git(workspace, 'commit', '-q', '-m', `branch ${item.branch}`);
      continue;
    }
    throw new Error(`unsupported special mutation: ${item.op}`);
  }
}

async function preparePhase3({ attempt, armBinding, binary, workspace, stateDirectory, frozen, baselineManifest, applyFrozenMutation }) {
  const stepEvidence = [];
  let mutationApplied = false;
  for (const [index, step] of frozen.contract.setupSteps.entries()) {
    if (index === 0) {
      stepEvidence.push({ step, status: 'verified' });
    } else if (step.startsWith('apply the frozen ')) {
      await applyFrozenMutation();
      mutationApplied = true;
      stepEvidence.push({ step, status: 'applied' });
    } else {
      const evidence = await runPhase3SetupStep({ attempt, armBinding, binary, workspace, stateDirectory, step });
      stepEvidence.push({ step, status: 'completed', evidence });
    }
  }
  if (!mutationApplied) await applyFrozenMutation();
  const trustedProductionSetup = await capturePhase3TrustedSetup({
    attempt, armBinding, binary, workspace, stateDirectory, frozen, baselineManifest, stepEvidence,
  });
  return { fields: {}, trustedProductionSetup, stepEvidence, deferred: [], artifactStore: path.join(stateDirectory, 'evidence') };
}

export function createRepresentativeLocalCallbacks({ armBinaries }) {
  if (!armBinaries || typeof armBinaries !== 'object') throw new Error('armBinaries are required');

  const prepareSetup = async (input) => {
    const { attempt, workspace, stateDirectory, runDirectory, frozen, applyFrozenMutation } = input;
    if (PHASE3_TASKS.has(attempt.taskID)) {
      return preparePhase3({ ...input, binary: binaryFor(attempt, armBinaries) });
    }
    const fields = {};
    const trustedProductionSetup = {};
    const stepEvidence = [{ step: frozen.contract.setupSteps[0], status: 'verified' }];
    const deferred = [];
    let artifactStore = path.join(stateDirectory, 'evidence');

    if (attempt.taskID.startsWith('git-diff-context-') || attempt.taskID.startsWith('worktree-compare-')) {
      await initializeGit(workspace);
    }

    if (attempt.taskID.startsWith('workspace-persistence-')) {
      const snapshot = await fullSnapshot(attempt, armBinaries, workspace, stateDirectory);
      fields.checkpoint = snapshot?.cursor ?? 'native-no-workspace-checkpoint';
      fields.cursor = fields.checkpoint;
      trustedProductionSetup.workspace_snapshot = { cursor: snapshot?.cursor ?? null, checkpointState: snapshot?.checkpointState ?? null };
    } else if (attempt.taskID.startsWith('project-profile-')) {
      const snapshot = await fullSnapshot(attempt, armBinaries, workspace, stateDirectory,
        attempt.arm === 'candidate'
          ? { project_profile: { mode: 'all', byte_budget: 262_144, profile_limit: 1_000 } } : {});
      trustedProductionSetup.workspace_snapshot = { cursor: snapshot?.cursor ?? null, projectProfiles: snapshot?.projectProfiles ?? [] };
    } else if (attempt.taskID.startsWith('workspace-wait-') || attempt.taskID === 'bilingual-workflow-english') {
      const snapshot = await fullSnapshot(attempt, armBinaries, workspace, stateDirectory);
      fields.cursor = snapshot?.cursor ?? 'native-no-workspace-cursor';
      trustedProductionSetup.workspace_snapshot = { cursor: snapshot?.cursor ?? null };
    } else if (attempt.taskID.startsWith('semantic-context-')) {
      const snapshot = await fullSnapshot(attempt, armBinaries, workspace, stateDirectory);
      fields.cursor = snapshot?.cursor ?? 'native-no-semantic-cursor';
      trustedProductionSetup.search_context = { cursor: snapshot?.cursor ?? null };
    }

    if (attempt.taskID.startsWith('artifact-query-')) {
      const artifactFiles = Object.keys(frozen.fixture.seedFiles).sort();
      const managedRuns = await createManagedArtifactRuns(attempt, armBinaries, workspace, stateDirectory, artifactFiles);
      const benchmarkArtifacts = await createBenchmarkArtifactStore(runDirectory, workspace, artifactFiles);
      fields.handles = benchmarkArtifacts.handles;
      if (managedRuns.length > 0) {
        fields.artifactRunAliases = Object.fromEntries(
          managedRuns.map(({ runID }, index) => [runID, `run-${index + 1}`]),
        );
      }
      artifactStore = benchmarkArtifacts.directory;
      trustedProductionSetup.artifact_read = { managedRuns };
    }

    if (attempt.taskID === 'workspace-wait-external-edit' || attempt.taskID === 'bilingual-workflow-english') {
      await applyFrozenMutation(async (mutation) => applySpecialMutation(workspace, mutation));
      deferred.push(...frozen.mutation.filter(({ op }) => op === 'delayed-write'));
    } else if (attempt.taskID === 'workspace-wait-event-gap') {
      await applyFrozenMutation(async (mutation) => applySpecialMutation(workspace, mutation));
      if (attempt.arm !== 'native') await replaceRootIdentity(workspace);
    } else if (attempt.taskID === 'worktree-compare-branch-diff') {
      await applyFrozenMutation(async (mutation) => applySpecialMutation(workspace, mutation));
    } else {
      await applyFrozenMutation();
      if (attempt.taskID === 'git-diff-context-staged-rename') await git(workspace, 'add', '-A');
    }

    return { fields, trustedProductionSetup, stepEvidence, deferred, artifactStore };
  };

  const deferredProcesses = new Map();
  const beforeAgentAttempt = async ({ attempt, workspace, setup }) => {
    const receipts = (setup.deferred ?? []).map((item) => {
      const target = safePath(workspace, item.path);
      const script = "const fs=require('node:fs');const [p,d,b]=process.argv.slice(1);setTimeout(()=>{try{fs.writeFileSync(p,Buffer.from(b,'base64'));process.exit(0)}catch(e){process.stderr.write(String(e));process.exit(1)}},Number(d));";
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          '-e', script, target, String(item.delayMs), Buffer.from(item.content, 'utf8').toString('base64'),
        ], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({
          path: item.path, delayMs: item.delayMs, exitCode: code, signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }));
      });
    });
    deferredProcesses.set(attempt.attemptID, receipts);
  };

  const afterAgentAttempt = async ({ attempt, runDirectory }) => {
    const promises = deferredProcesses.get(attempt.attemptID) ?? [];
    deferredProcesses.delete(attempt.attemptID);
    const receipts = await Promise.all(promises);
    await writeFile(
      path.join(runDirectory, 'deferred-mutation-receipts.json'),
      `${JSON.stringify({ schema: 'aishell.deferred-mutation-receipts.v1', receipts }, null, 2)}\n`,
      { flag: 'wx' },
    );
    const failed = receipts.find(({ exitCode, signal }) => exitCode !== 0 || signal !== null);
    if (failed) throw new Error(`deferred mutation failed: ${JSON.stringify(failed)}`);
  };

  const materializePrompt = async (input) => materializeRepresentativePrompt(input);

  const validateSetupEvidence = async ({ attempt, workspace, baselineManifest, preAttemptManifest, setupEvidence }) => {
    if (PHASE3_TASKS.has(attempt.taskID)) return;
    materializeRequestContract({
      taskId: attempt.taskID,
      workspaceRoot: workspace,
      preAttemptManifest,
      baselineManifest,
      setupEvidence,
      suite: SUITE,
      catalog: CATALOG,
      execution: EXECUTION,
    });
  };

  return {
    prepareSetup, beforeAgentAttempt, afterAgentAttempt, materializePrompt, validateSetupEvidence,
    exchangeMCP, observeProviderModel, runProcess, collectRepresentativeAttemptEvidence,
  };
}
