#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureManifest } from './capture-workspace-manifest.mjs';
import { materializeGeneratedSeed } from './materialize-generated-seed.mjs';
import {
  exactByteBinding,
  extractProviderModelsFromSSETrace,
  extractProviderUsageFromSSETrace,
  runPhase3Attempts,
} from './phase3-representative-runner.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';

const here = new URL('.', import.meta.url);
const MCP_WIRE_TAP = fileURLToPath(new URL('phase3-mcp-wire-tap.mjs', here));
const ARMS = new Set(['native', 'current-aishell-0.3.3', 'candidate']);

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new Error(`${label} callback is required`);
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has invalid fields`);
  }
}

function sandboxArguments(configuration) {
  exactObjectKeys(configuration, ['approvalPolicy', 'filesystem', 'network'], 'sandboxConfiguration');
  const { approvalPolicy, filesystem, network } = configuration;
  if (approvalPolicy === 'bypass' && filesystem === 'danger-full-access' && network === true) {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  if (!['never', 'on-request'].includes(approvalPolicy) || typeof network !== 'boolean'
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(filesystem)) {
    throw new Error('sandboxConfiguration has no exact Codex argv mapping');
  }
  if ((filesystem === 'read-only' && network !== false) || (filesystem === 'danger-full-access' && network !== true)) {
    throw new Error('sandboxConfiguration network policy cannot be represented exactly');
  }
  const args = ['--sandbox', filesystem, '--config', `approval_policy=${tomlString(approvalPolicy)}`];
  if (filesystem === 'workspace-write') {
    args.push('--config', `sandbox_workspace_write.network_access=${network ? 'true' : 'false'}`);
  }
  return args;
}

function validateCommonCodexArguments(args) {
  const forbiddenFlags = new Set([
    '--model', '-m', '--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox',
    '--cd', '-C', '--add-dir', '--profile', '-p', '--oss', '--local-provider',
  ]);
  const forbiddenConfig = /^(?:model(?:\.|$)|model_reasoning_effort(?:\.|$)|approval_policy(?:\.|$)|sandbox(?:\.|_|$)|mcp_servers(?:\.|$))/u;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const flag = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (forbiddenFlags.has(flag)) throw new Error(`commonCodexArguments may not override benchmark control: ${flag}`);
    let config = null;
    if (argument === '--config' || argument === '-c') {
      config = args[index + 1];
      if (typeof config !== 'string') throw new Error('commonCodexArguments has incomplete config override');
      index += 1;
    } else if (argument.startsWith('--config=')) {
      config = argument.slice('--config='.length);
    } else if (argument.startsWith('-c=')) {
      config = argument.slice(3);
    }
    if (config !== null) {
      const separator = config.indexOf('=');
      const key = separator < 0 ? '' : config.slice(0, separator).trim();
      if (!key || forbiddenConfig.test(key)) {
        throw new Error(`commonCodexArguments may not override benchmark config: ${key || '<invalid>'}`);
      }
    }
  }
}

function within(root, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error(`${label} has an invalid relative path`);
  }
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes workspace`);
  return target;
}

async function writeJSON(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function digestFile(file) {
  return sha256Hex(await readFile(file));
}

function validateProviderModelEvidence(value, bytes, providerTraceBytes, providerSSEBytes, expectedMainModel, expectedReviewer) {
  exactObjectKeys(value, [
    'schema', 'source', 'models',
    'providerTraceSHA256', 'providerSSETraceSHA256',
  ], 'provider model evidence');
  const models = extractProviderModelsFromSSETrace(providerSSEBytes);
  const expectedModels = [expectedMainModel, ...expectedReviewer.modelSnapshots].sort();
  if (value.schema !== 'aishell.provider-model-evidence.v3' || value.source !== 'codex-provider-sse'
    || JSON.stringify(value.models) !== JSON.stringify(models)
    || JSON.stringify(models.map(({ modelSnapshot }) => modelSnapshot)) !== JSON.stringify(expectedModels)
    || value.providerTraceSHA256 !== sha256Hex(providerTraceBytes)
    || value.providerSSETraceSHA256 !== sha256Hex(providerSSEBytes)) {
    throw new Error('provider model evidence is not bound to trusted provider metadata');
  }
  if (!canonicalJSONBytes(value).equals(bytes)) {
    throw new Error('provider model evidence must be canonical JSON bytes');
  }
  return value;
}

function providerSSETrace(stderrBytes) {
  const raw = Buffer.from(stderrBytes);
  const marker = Buffer.from('Received message ');
  const selected = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0x0a) continue;
    let end = index;
    if (end > start && raw[end - 1] === 0x0d) end -= 1;
    const line = raw.subarray(start, end);
    const markerOffset = line.indexOf(marker);
    if (markerOffset >= 0) {
      const eventBytes = line.subarray(markerOffset + marker.length);
      try {
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(eventBytes));
        if (event?.type === 'response.created' || event?.type === 'response.completed') {
          selected.push(Buffer.from(eventBytes), Buffer.from('\n'));
        }
      } catch { /* Non-JSON protocol diagnostics are not provider response evidence. */ }
    }
    start = index + 1;
  }
  return Buffer.concat(selected);
}

function diagnosticStderr(stderrBytes) {
  const text = Buffer.from(stderrBytes).toString('utf8');
  return Buffer.from(text.split('\n').filter((line) => !line.includes('tungstenite::protocol')).join('\n'));
}

async function loadFrozenTask(taskID) {
  const [suite, catalog, execution] = await Promise.all([
    readFile(new URL('representative-suite.v1.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('capability-fixtures.v1.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('representative-execution-contracts.v1.json', here), 'utf8').then(JSON.parse),
  ]);
  const task = suite.tasks.find(({ id }) => id === taskID);
  const fixture = catalog.fixtures.find(({ id }) => id === task?.fixture);
  const scenario = fixture?.scenarios?.[task?.scenario];
  const contract = execution.contracts.find(({ taskId }) => taskId === taskID);
  if (!task || !fixture || !scenario || !contract) throw new Error(`unknown frozen task: ${taskID}`);
  return {
    task: { id: task.id, fixture: task.fixture, scenario: task.scenario },
    fixture: { id: fixture.id, seedFiles: fixture.seedFiles, ...(fixture.generatedSeed ? { generatedSeed: fixture.generatedSeed } : {}) },
    mutation: scenario.mutation,
    contract,
  };
}

async function materializeSeed(workspace, fixture) {
  for (const [relative, content] of Object.entries(fixture.seedFiles).sort(([left], [right]) => left.localeCompare(right))) {
    const target = within(workspace, relative, 'seed');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
  if (fixture.generatedSeed) await materializeGeneratedSeed(workspace, fixture.generatedSeed);
}

async function applyMutation(workspace, mutation) {
  for (const item of mutation) {
    if (item.op === 'write' || item.op === 'create') {
      const target = within(workspace, item.path, 'mutation');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, item.content, item.op === 'create' ? { flag: 'wx' } : undefined);
    } else if (item.op === 'delete') {
      await rm(within(workspace, item.path, 'mutation'), { force: false });
    } else if (item.op === 'rename') {
      const from = within(workspace, item.from, 'mutation');
      const to = within(workspace, item.to, 'mutation');
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
    } else {
      throw new Error(`unsupported frozen mutation: ${item.op}`);
    }
  }
}

function parseJSONLines(bytes) {
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: 'invalid_jsonl', raw: line }; }
  });
}

function agentResult(events, taskID) {
  const messages = events
    .filter((event) => event?.type === 'item.completed' && event.item?.type === 'agent_message')
    .map((event) => event.item.text);
  const text = messages.at(-1);
  try {
    const value = JSON.parse(text);
    return { value, bytes: canonicalJSONBytes(value) };
  } catch {
    const value = { schema: 'aishell.invalid-agent-result.v1', taskId: taskID, reason: 'final_agent_message_is_not_json' };
    return { value, bytes: canonicalJSONBytes(value) };
  }
}

function toolTrace(events) {
  const selected = events.filter((event) => {
    const type = event?.item?.type ?? event?.type;
    return typeof type === 'string' && type !== 'agent_message'
      && (event?.type === 'item.started' || event?.type === 'item.completed');
  });
  return { schema: 'aishell.phase3-codex-tool-trace.v1', events: selected };
}

function defaultRunProcess(command, args, { cwd, env, timeoutMilliseconds }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMilliseconds);
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exitCode ?? -1, timedOut });
    });
  });
}

function codexArguments({ prompt, workspace, attempt, isolation, options, stateDirectory, mcpWireDirectory }) {
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--color', 'never', ...options.sandboxArguments,
    '--config', `approvals_reviewer=${tomlString(options.approvalReviewer.mode)}`,
    '--config', `model_reasoning_effort=${tomlString(isolation.reasoningEffort)}`,
    '--model', isolation.modelSnapshot,
    '--cd', workspace,
    ...options.commonCodexArguments,
  ];
  if (attempt.arm !== 'native') {
    const binary = options.armBinaries[attempt.arm];
    const capability = attempt.arm === 'candidate'
      ? `, AISHELL_CAPABILITY_SET = ${tomlString('expanded-v1')}` : '';
    args.push('--config', `mcp_servers.aishell.command=${tomlString(process.execPath)}`);
    args.push('--config', `mcp_servers.aishell.args=${JSON.stringify([MCP_WIRE_TAP, binary])}`);
    args.push('--config', `mcp_servers.aishell.env={ AISHELL_STATE_DIRECTORY = ${tomlString(stateDirectory)}, AISHELL_TOOL_PROFILE = ${tomlString('development')}${capability}, AISHELL_PHASE3_MCP_WIRE_DIRECTORY = ${tomlString(mcpWireDirectory)} }`);
  }
  args.push(prompt);
  return args;
}

async function validateBindings(attempt, armBinding, options) {
  if (!ARMS.has(attempt.arm)) throw new Error(`unknown benchmark arm: ${attempt.arm}`);
  if (attempt.arm === 'native') return;
  const binary = options.armBinaries[attempt.arm];
  if (await digestFile(binary) !== armBinding.aishellBinaryDigest) {
    throw new Error(`${attempt.arm} binary digest differs from manifest`);
  }
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('executor options are required');
  const outputDirectory = requireAbsolutePath(options.outputDirectory, 'outputDirectory');
  const codexCommand = options.codexCommand ?? 'codex';
  if (typeof codexCommand !== 'string' || codexCommand.length === 0) throw new Error('codexCommand is invalid');
  const armBinaries = {
    'current-aishell-0.3.3': requireAbsolutePath(options.armBinaries?.['current-aishell-0.3.3'], 'current binary'),
    candidate: requireAbsolutePath(options.armBinaries?.candidate, 'candidate binary'),
  };
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 300_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) throw new Error('timeoutMilliseconds is invalid');
  if (!Array.isArray(options.commonCodexArguments) || options.commonCodexArguments.some((item) => typeof item !== 'string')) {
    throw new Error('commonCodexArguments must be an exact argv array');
  }
  if (!options.sandboxConfiguration || typeof options.sandboxConfiguration !== 'object' || Array.isArray(options.sandboxConfiguration)) {
    throw new Error('sandboxConfiguration must be the exact run configuration object');
  }
  if (!/^[a-f0-9]{64}$/u.test(options.commonHostCatalogDigest ?? '')) {
    throw new Error('commonHostCatalogDigest must be SHA-256');
  }
  const exactSandboxArguments = sandboxArguments(options.sandboxConfiguration);
  if (options.approvalReviewer?.mode !== 'auto_review' || !Array.isArray(options.approvalReviewer.modelSnapshots)
    || options.approvalReviewer.modelSnapshots.length === 0
    || options.approvalReviewer.modelSnapshots.some((model) => typeof model !== 'string' || model.length === 0)
    || new Set(options.approvalReviewer.modelSnapshots).size !== options.approvalReviewer.modelSnapshots.length
    || JSON.stringify(options.approvalReviewer.modelSnapshots) !== JSON.stringify([...options.approvalReviewer.modelSnapshots].sort())) {
    throw new Error('approvalReviewer must freeze auto-review model snapshots');
  }
  validateCommonCodexArguments(options.commonCodexArguments);
  return {
    ...options,
    outputDirectory,
    codexCommand,
    armBinaries,
    sandboxArguments: exactSandboxArguments,
    approvalReviewer: structuredClone(options.approvalReviewer),
    timeoutMilliseconds,
    setupAttempt: requireFunction(options.setupAttempt, 'setupAttempt'),
    observeToolCatalog: requireFunction(options.observeToolCatalog, 'observeToolCatalog'),
    observeProviderModel: requireFunction(options.observeProviderModel, 'observeProviderModel'),
    observeAttempt: requireFunction(options.observeAttempt, 'observeAttempt'),
    runProcess: options.runProcess ?? defaultRunProcess,
  };
}

/**
 * Build the callback consumed by runPhase3Attempts. setupAttempt owns runtime-specific setup
 * ordering, but can apply the frozen mutation only through applyFrozenMutation, exactly once.
 */
export function createPhase3CodexExecutor(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const pairedFixtureDigests = new Map();
  return async function executeAttempt({ attempt, isolation, armBinding, prompt }) {
    if (!/^[a-z0-9.-]+$/u.test(attempt.attemptID ?? '')) throw new Error('attemptID is unsafe');
    await validateBindings(attempt, armBinding, options);
    if (sha256Hex(canonicalJSONBytes(armBinding)) !== attempt.armBindingSHA256) {
      throw new Error(`arm binding differs from manifest: ${attempt.attemptID}`);
    }
    if (sha256Hex(Buffer.from(prompt, 'utf8')) !== attempt.promptSHA256) {
      throw new Error(`prompt differs from manifest: ${attempt.attemptID}`);
    }
    if (sha256Hex(canonicalJSONBytes(options.sandboxConfiguration)) !== isolation.sandboxSHA256) {
      throw new Error('sandbox configuration differs from manifest');
    }
    if (options.commonHostCatalogDigest !== isolation.commonHostCatalogDigest) {
      throw new Error('common host catalog differs from manifest');
    }
    if (JSON.stringify(options.approvalReviewer) !== JSON.stringify(isolation.approvalReviewer)) {
      throw new Error('approval reviewer differs from manifest');
    }
    const runDirectory = path.join(options.outputDirectory, attempt.attemptID);
    const workspace = path.join(runDirectory, 'workspace');
    const stateDirectory = path.join(runDirectory, 'runtime-state');
    const mcpWireDirectory = path.join(runDirectory, 'mcp-wire');
    await mkdir(options.outputDirectory, { recursive: true });
    await mkdir(runDirectory, { recursive: false });
    await mkdir(workspace, { recursive: false });
    await mkdir(stateDirectory, { recursive: false });
    const frozen = await loadFrozenTask(attempt.taskID);
    const fixtureContractDigest = sha256Hex(canonicalJSONBytes({
      fixtureID: frozen.fixture.id,
      seedFiles: frozen.fixture.seedFiles,
      mutation: frozen.mutation,
    }));
    if (fixtureContractDigest !== attempt.materializedFixtureSHA256) {
      throw new Error(`frozen fixture contract differs from manifest: ${attempt.attemptID}`);
    }
    await materializeSeed(workspace, frozen.fixture);
    const baselineManifest = await captureManifest(workspace);
    await writeJSON(path.join(runDirectory, 'baseline-manifest.json'), baselineManifest);
    await writeJSON(path.join(stateDirectory, 'runtime.json'), {
      allowedRootPaths: [workspace], isPaused: false, updatedAt: '2001-01-01T00:00:00Z',
    });

    let mutationCount = 0;
    const setup = await options.setupAttempt({
      attempt: structuredClone(attempt),
      armBinding: structuredClone(armBinding),
      workspace,
      stateDirectory,
      frozen: structuredClone(frozen),
      baselineManifest: structuredClone(baselineManifest),
      applyFrozenMutation: async () => {
        if (mutationCount !== 0) throw new Error(`frozen mutation applied more than once: ${attempt.attemptID}`);
        mutationCount += 1;
        await applyMutation(workspace, frozen.mutation);
      },
    });
    if (mutationCount !== 1) throw new Error(`setup did not apply frozen mutation exactly once: ${attempt.attemptID}`);
    if (!setup || typeof setup !== 'object') throw new Error(`setup evidence is missing: ${attempt.attemptID}`);
    await writeJSON(path.join(runDirectory, 'setup-evidence.json'), setup);
    const preAttemptManifest = await captureManifest(workspace);
    const pairingKey = `${attempt.taskID}\0${attempt.repetition}`;
    const pairedDigest = pairedFixtureDigests.get(pairingKey);
    if (pairedDigest !== undefined && pairedDigest !== preAttemptManifest.digest) {
      throw new Error(`materialized workspace differs across arms: ${attempt.taskID} repetition ${attempt.repetition}`);
    }
    pairedFixtureDigests.set(pairingKey, preAttemptManifest.digest);
    await writeJSON(path.join(runDirectory, 'pre-attempt-manifest.json'), preAttemptManifest);
    let observedCatalogDigest = null;
    let observedBinaryDigest = null;
    if (attempt.arm !== 'native') {
      const binary = options.armBinaries[attempt.arm];
      const profile = attempt.arm === 'candidate' ? 'expanded-v1' : 'development';
      observedBinaryDigest = await digestFile(binary);
      observedCatalogDigest = await options.observeToolCatalog({ binary, profile, stateDirectory, workspace });
      if (observedCatalogDigest !== armBinding.aishellToolCatalogDigest) {
        throw new Error(`${attempt.arm} tool catalog digest differs from manifest`);
      }
    }
    const args = codexArguments({ prompt, workspace, attempt, isolation, options, stateDirectory, mcpWireDirectory });
    await writeJSON(path.join(runDirectory, 'codex-invocation.json'), {
      command: options.codexCommand, args, cwd: workspace,
      armBinding, isolation,
      environmentBindings: { GIT_CEILING_DIRECTORIES: options.outputDirectory },
    });
    const started = performance.now();
    const execution = await options.runProcess(options.codexCommand, args, {
      cwd: workspace, env: {
        ...process.env, ...(options.environment ?? {}),
        GIT_CEILING_DIRECTORIES: options.outputDirectory,
        RUST_LOG: 'tungstenite::protocol=trace',
      },
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
    const wallMilliseconds = Math.round(performance.now() - started);
    const stdout = Buffer.from(execution.stdout ?? '');
    const stderr = Buffer.from(execution.stderr ?? '');
    const providerSSEBytes = providerSSETrace(stderr);
    await writeFile(path.join(runDirectory, 'provider-events.jsonl'), stdout, { flag: 'wx' });
    await writeFile(path.join(runDirectory, 'provider-sse.jsonl'), providerSSEBytes, { flag: 'wx' });
    await writeFile(path.join(runDirectory, 'stderr.log'), diagnosticStderr(stderr), { flag: 'wx' });
    if (execution.timedOut) {
      let providerModels = null;
      let extractedUsage = null;
      try { providerModels = extractProviderModelsFromSSETrace(providerSSEBytes); } catch { /* Raw incomplete SSE remains the evidence. */ }
      try { extractedUsage = extractProviderUsageFromSSETrace(providerSSEBytes); } catch { /* Missing usage remains invalid, never zero. */ }
      await writeJSON(path.join(runDirectory, 'provider-usage.json'), {
        format: extractedUsage?.format ?? null, usage: null,
      });
      return {
        attemptID: attempt.attemptID,
        sequence: attempt.sequence,
        taskID: attempt.taskID,
        arm: attempt.arm,
        repetition: attempt.repetition,
        usage: null,
        providerTrace: exactByteBinding(stdout),
        providerSSE: exactByteBinding(providerSSEBytes),
        providerModels,
        providerUsageFormat: extractedUsage?.format ?? null,
        agentResult: exactByteBinding(Buffer.alloc(0)),
        adapterTrace: null,
        agentExitCode: execution.exitCode,
        timedOut: true,
        wallMilliseconds,
      };
    }
    const rawProviderModelEvidence = await options.observeProviderModel(Object.freeze({
      providerTraceBytes: Buffer.from(stdout),
      providerSSEBytes: Buffer.from(providerSSEBytes),
      mainModelSnapshot: isolation.modelSnapshot,
      approvalReviewer: structuredClone(isolation.approvalReviewer),
    }));
    if (!Buffer.isBuffer(rawProviderModelEvidence) && !ArrayBuffer.isView(rawProviderModelEvidence)) {
      throw new Error('observeProviderModel must return trusted evidence bytes, not a requested-model echo');
    }
    const providerModelEvidenceBytes = Buffer.from(rawProviderModelEvidence);
    let providerModelEvidenceValue;
    try {
      providerModelEvidenceValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(providerModelEvidenceBytes));
    } catch {
      throw new Error('provider model evidence must be UTF-8 JSON');
    }
    const providerModelEvidence = validateProviderModelEvidence(
      providerModelEvidenceValue, providerModelEvidenceBytes, stdout, providerSSEBytes,
      isolation.modelSnapshot, isolation.approvalReviewer,
    );
    await writeFile(path.join(runDirectory, 'provider-model-evidence.json'), providerModelEvidenceBytes, { flag: 'wx' });
    await writeJSON(path.join(runDirectory, 'observed-bindings.json'), {
      arm: attempt.arm,
      binarySHA256: observedBinaryDigest,
      aishellToolCatalogSHA256: observedCatalogDigest,
      workspaceSHA256: preAttemptManifest.digest,
      promptSHA256: sha256Hex(Buffer.from(prompt, 'utf8')),
      sandboxSHA256: sha256Hex(canonicalJSONBytes(options.sandboxConfiguration)),
      commonHostCatalogSHA256: options.commonHostCatalogDigest,
      requestedModelSnapshot: isolation.modelSnapshot,
      requestedApprovalReviewer: isolation.approvalReviewer,
      actualProviderModels: providerModelEvidence.models,
      providerModelEvidenceSHA256: sha256Hex(providerModelEvidenceBytes),
      mcpWireTapSHA256: attempt.arm === 'native' ? null : await digestFile(MCP_WIRE_TAP),
    });
    const events = parseJSONLines(stdout);
    const finalAgent = agentResult(events, attempt.taskID);
    await writeFile(path.join(runDirectory, 'agent-result.json'), finalAgent.bytes, { flag: 'wx' });
    const derivedToolTrace = toolTrace(events);
    await writeJSON(path.join(runDirectory, 'tool-trace.json'), derivedToolTrace);

    const observed = await options.observeAttempt({
      attempt: structuredClone(attempt), workspace, stateDirectory, runDirectory,
      mcpWireDirectory: attempt.arm === 'native' ? undefined : mcpWireDirectory,
      baselineManifest: structuredClone(baselineManifest),
      preAttemptManifest: structuredClone(preAttemptManifest),
      setup: structuredClone(setup), events: structuredClone(events),
      toolTrace: structuredClone(derivedToolTrace), finalAgent: structuredClone(finalAgent.value),
      execution: { exitCode: execution.exitCode, timedOut: execution.timedOut, wallMilliseconds },
    });
    if (!observed || typeof observed !== 'object' || !observed.observerEvidence) {
      throw new Error(`observer evidence is missing: ${attempt.attemptID}`);
    }
    await writeJSON(path.join(runDirectory, 'observer-evidence.json'), observed.observerEvidence);
    let extractedUsage = null;
    try { extractedUsage = extractProviderUsageFromSSETrace(providerSSEBytes); } catch { /* Missing usage remains an invalid run, never zero. */ }
    const usage = execution.timedOut ? null : extractedUsage?.usage ?? null;
    const providerUsageFormat = extractedUsage?.format ?? null;
    await writeJSON(path.join(runDirectory, 'provider-usage.json'), { format: providerUsageFormat, usage });
    const adapterTraceBytes = observed.adapterTraceBytes == null ? null : Buffer.from(observed.adapterTraceBytes);
    if (adapterTraceBytes) await writeFile(path.join(runDirectory, 'adapter-trace.json'), adapterTraceBytes, { flag: 'wx' });

    return {
      attemptID: attempt.attemptID,
      sequence: attempt.sequence,
      taskID: attempt.taskID,
      arm: attempt.arm,
      repetition: attempt.repetition,
      usage,
      providerTrace: exactByteBinding(stdout),
      providerSSE: exactByteBinding(providerSSEBytes),
      providerModels: providerModelEvidence.models,
      providerUsageFormat,
      agentResult: exactByteBinding(finalAgent.bytes),
      adapterTrace: attempt.arm === 'candidate' && adapterTraceBytes ? exactByteBinding(adapterTraceBytes) : null,
      agentExitCode: execution.exitCode,
      timedOut: Boolean(execution.timedOut),
      wallMilliseconds,
    };
  };
}

/** Execute all 54 manifest attempts in their frozen order through Codex CLI. */
export async function runPhase3CodexBenchmark({ manifest, executorOptions }) {
  return runPhase3Attempts({ manifest, executeAttempt: createPhase3CodexExecutor(executorOptions) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('phase3-codex-executor.mjs is a library; bind trusted setup and observer callbacks from the benchmark harness');
}
