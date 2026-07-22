#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsMap.set(process.argv[index], process.argv[index + 1]);
}
const binary = path.resolve(argumentsMap.get('--binary') ?? path.join(repository, '.build/debug/aishell-mcp'));
const outputPath = argumentsMap.get('--out') ? path.resolve(argumentsMap.get('--out')) : null;
const fixtureSource = path.join(repository, 'benchmarks/fixtures/capability-v2');

class MCPClient {
  constructor(executable, stateDirectory) {
    this.nextID = 1;
    this.pending = new Map();
    this.process = spawn(executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AISHELL_STATE_DIRECTORY: stateDirectory,
        AISHELL_TOOL_PROFILE: 'development',
        AISHELL_CAPABILITY_SET: 'expanded-v1'
      }
    });
    this.stderr = '';
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.process.stdout.setEncoding('utf8');
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
    const id = this.nextID++;
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

  async tool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    if (response.result?.isError) {
      throw new Error(`${name}: ${response.result.content?.[0]?.text ?? 'typed tool failure'}`);
    }
    return response.result.structuredContent;
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'phase4-harness', version: '1' }
    });
  }

  async close() {
    this.process.stdin.end();
    const terminal = await this.exit;
    if (terminal.code !== 0) throw new Error(`aishell-mcp exited ${terminal.code}: ${this.stderr}`);
  }
}

function now() { return performance.now(); }
function elapsed(start) { return Math.round((now() - start) * 1000) / 1000; }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function terminalStatus(client, runHandle, initialRevision, initialCursor) {
  let revision = initialRevision;
  let cursor = initialCursor;
  let roundTrips = 0;
  for (;;) {
    roundTrips += 1;
    const waited = await client.tool('run_observe', {
      action: 'wait', run_handle: runHandle, after_state_revision: revision,
      cursor, timeout_ms: 2_000
    });
    const status = waited.status;
    revision = status.stateRevision;
    cursor = status.evidenceCursor;
    if (['passed', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(status.state)) {
      return { status, roundTrips };
    }
  }
}

async function measure(root, stateDirectory) {
  const client = new MCPClient(binary, stateDirectory);
  await client.initialize();
  const executionPolicy = { timeout_ms: 15_000, retention_seconds: 3_600 };
  const directInvocation = {
    mode: 'direct', executable: 'node', arguments: ['slow.mjs'],
    working_directory: root, environment: {}
  };

  const candidateStartedAt = now();
  const started = await client.tool('run_check', {
    schema: 'aishell.run-check.v2', invocation: directInvocation,
    dispatch: { mode: 'start', client_run_key: 'phase4-first-useful' },
    cache: 'off', execution_policy: executionPolicy, selection: { binding: 'prepare' }
  });
  let evidenceCursor;
  let firstUsefulMilliseconds = null;
  let candidateRoundTrips = 1;
  for (;;) {
    candidateRoundTrips += 1;
    const read = await client.tool('run_observe', {
      action: 'read', run_handle: started.runHandle,
      ...(evidenceCursor ? { cursor: evidenceCursor } : {}), byte_budget: 65_536
    });
    evidenceCursor = read.cursor;
    if (read.chunks.some((chunk) => chunk.text?.includes('first failure'))) {
      firstUsefulMilliseconds = elapsed(candidateStartedAt);
      break;
    }
    candidateRoundTrips += 1;
    await client.tool('run_observe', {
      action: 'wait', run_handle: started.runHandle,
      after_state_revision: read.status.stateRevision, cursor: evidenceCursor, timeout_ms: 2_000
    });
  }
  const firstUsefulRoundTrips = candidateRoundTrips;
  const candidateTerminalObservation = await terminalStatus(
    client, started.runHandle, started.stateRevision, evidenceCursor
  );
  candidateRoundTrips += candidateTerminalObservation.roundTrips;
  const candidateTerminal = candidateTerminalObservation.status;
  const candidateWallMilliseconds = elapsed(candidateStartedAt);

  const baselineStartedAt = now();
  const baseline = await client.tool('run_check', {
    executable: 'node', arguments: ['slow.mjs'], working_directory: root,
    timeout_seconds: 15, retention_seconds: 3_600
  });
  const baselineFirstUsefulMilliseconds = elapsed(baselineStartedAt);

  const cancelStartedAt = now();
  const cancellable = await client.tool('run_check', {
    schema: 'aishell.run-check.v2', invocation: directInvocation,
    dispatch: { mode: 'start', client_run_key: 'phase4-cancel' },
    cache: 'off', execution_policy: executionPolicy, selection: { binding: 'prepare' }
  });
  await sleep(100);
  const cancelled = await client.tool('run_observe', {
    action: 'cancel', run_handle: cancellable.runHandle
  });
  const cancelAcknowledgedMilliseconds = elapsed(cancelStartedAt);
  const cancelTerminalObservation = await terminalStatus(
    client, cancellable.runHandle, cancelled.stateRevision, cancelled.evidenceCursor
  );
  const cancelTerminal = cancelTerminalObservation.status;
  const cancelWallMilliseconds = elapsed(cancelStartedAt);

  const stateFile = path.join(root, 'state.txt');
  await writeFile(stateFile, 'one\n');
  const candidateSnapshot = await client.tool('workspace_snapshot', { path: root, context_budget: 0 });
  const candidateWaitStartedAt = now();
  const delayedCandidateEdit = sleep(100).then(() => writeFile(stateFile, 'two\n'));
  const changed = await client.tool('workspace_wait', {
    path: root, from_cursor: candidateSnapshot.cursor, timeout_ms: 5_000
  });
  await delayedCandidateEdit;
  const candidateWaitWallMilliseconds = elapsed(candidateWaitStartedAt);

  await writeFile(stateFile, 'one\n');
  await sleep(100);
  const baselineSnapshot = await client.tool('workspace_snapshot', { path: root, context_budget: 0 });
  const baselineWaitStartedAt = now();
  const delayedBaselineEdit = sleep(100).then(() => writeFile(stateFile, 'two\n'));
  let baselinePolls = 0;
  let baselineDelta;
  do {
    await sleep(25);
    baselinePolls += 1;
    baselineDelta = await client.tool('workspace_snapshot', {
      path: root, since_cursor: baselineSnapshot.cursor, context_budget: 0
    });
  } while (!baselineDelta.changes.some((change) => change.path === 'state.txt'));
  await delayedBaselineEdit;
  const baselineWaitWallMilliseconds = elapsed(baselineWaitStartedAt);

  await client.close();
  assert.equal(candidateTerminal.state, 'failed');
  assert.equal(baseline.status, 'failed');
  assert.ok(candidateTerminal.stderrArtifact?.sha256, 'terminal stderr artifact SHA is required');
  assert.ok(firstUsefulMilliseconds < baselineFirstUsefulMilliseconds * 0.25,
    `candidate first useful ${firstUsefulMilliseconds}ms is not materially earlier than baseline ${baselineFirstUsefulMilliseconds}ms`);
  assert.ok(candidateWallMilliseconds <= baselineFirstUsefulMilliseconds * 1.25,
    'async lifecycle must not materially regress terminal wall time');
  assert.ok(['cancelling', 'cancelled'].includes(cancelled.state));
  assert.equal(cancelTerminal.state, 'cancelled');
  assert.ok(cancelWallMilliseconds < 2_000, 'cancel must not wait for the 10 second worker');
  assert.equal(changed.status, 'changed');
  assert.deepEqual(changed.changedPaths, ['state.txt']);
  assert.ok(baselinePolls >= 1, 'polling baseline must perform at least one observation');
  assert.ok(candidateWaitWallMilliseconds <= baselineWaitWallMilliseconds + 250,
    'workspace_wait must not materially regress external-edit wall time');

  return {
    schema: 'aishell.phase4-acceptance.v1', measuredAt: new Date().toISOString(),
    binary, fixture: 'benchmarks/fixtures/capability-v2',
    longBuildIncrementalFailure: {
      candidate: {
        firstUsefulMilliseconds, wallMilliseconds: candidateWallMilliseconds,
        firstUsefulToolRoundTrips: firstUsefulRoundTrips,
        terminalToolRoundTrips: candidateRoundTrips,
        terminalState: candidateTerminal.state,
        stderrArtifactSHA256: candidateTerminal.stderrArtifact.sha256
      },
      pollingBaseline: {
        firstUsefulMilliseconds: baselineFirstUsefulMilliseconds,
        wallMilliseconds: baselineFirstUsefulMilliseconds, toolRoundTrips: 1,
        terminalState: baseline.status
      },
      firstUsefulRatio: firstUsefulMilliseconds / baselineFirstUsefulMilliseconds,
      wallRatio: candidateWallMilliseconds / baselineFirstUsefulMilliseconds
    },
    cancel: {
      acknowledgementMilliseconds: cancelAcknowledgedMilliseconds,
      acknowledgementState: cancelled.state,
      candidateWallMilliseconds: cancelWallMilliseconds,
      terminalState: cancelTerminal.state,
      baselineWorkerMilliseconds: 10_000
    },
    externalEdit: {
      candidateWallMilliseconds: candidateWaitWallMilliseconds,
      candidateWaitCalls: 1,
      baselineWallMilliseconds: baselineWaitWallMilliseconds,
      baselinePollCalls: baselinePolls,
      changedPaths: changed.changedPaths
    },
    assertions: {
      firstUsefulEarlier: true, terminalWallNonRegression: true,
      cancelBeforeNaturalExit: true, externalEditNoWallRegression: true,
      externalEditRoundTripsNotIncreased: baselinePolls >= 1, silentFallbacks: 0
    }
  };
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aishell-phase4-'));
try {
  const fixture = path.join(temporaryRoot, 'fixture');
  const stateDirectory = path.join(temporaryRoot, 'state');
  await cp(fixtureSource, fixture, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, 'runtime.json'), `${JSON.stringify({
    allowedRootPaths: [fixture], isPaused: false, updatedAt: new Date().toISOString()
  })}\n`);
  const report = await measure(fixture, stateDirectory);
  report.binarySHA256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, encoded);
  process.stdout.write(encoded);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
