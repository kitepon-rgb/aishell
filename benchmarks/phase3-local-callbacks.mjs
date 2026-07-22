#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  candidateAdapterTraceBytes,
  prepareCandidateRequests,
  recordCandidateProjection,
} from './phase3-representative-runner.mjs';
import {
  buildBenchmarkTrace,
  canonicalJSONBytes,
  frozenRunCheckBindingDigest,
  projectProductionV2Result,
  sha256Hex,
} from './production-v2-benchmark-adapter.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} has invalid fields`);
  }
}

function bytes(value, label) {
  if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) throw new Error(`${label} exact bytes are required`);
  return Buffer.from(value);
}

function positiveInteger(value, label) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function envTimeout(name) {
  return positiveInteger(process.env[name], name);
}

function armBinary(arm) {
  const name = arm === 'candidate' ? 'AISHELL_PHASE3_CANDIDATE_BINARY'
    : arm === 'current-aishell-0.3.3' ? 'AISHELL_PHASE3_CURRENT_BINARY' : null;
  if (!name) return null;
  const value = process.env[name];
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) {
    throw new Error(`${name} must be a normalized absolute path`);
  }
  return value;
}

async function verifiedArmBinary(attempt, armBinding) {
  const binary = armBinary(attempt.arm);
  if (!binary) throw new Error(`AIShell MCP is unavailable for native arm: ${attempt.taskID}`);
  if (!plainObject(armBinding) || !SHA256.test(armBinding.aishellBinaryDigest ?? '')) {
    throw new Error(`${attempt.arm} arm binding digest is unavailable`);
  }
  const actualDigest = sha256Hex(await readFile(binary));
  if (actualDigest !== armBinding.aishellBinaryDigest) {
    throw new Error(`${attempt.arm} environment binary differs from the measured arm binding`);
  }
  return binary;
}

function collectProcess(command, args, { cwd, env, timeoutMilliseconds, input = null }) {
  if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)
    || args.some((item) => typeof item !== 'string') || !path.isAbsolute(cwd)) {
    throw new Error('process invocation is invalid');
  }
  const timeout = positiveInteger(timeoutMilliseconds, 'process timeout');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let closed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    }, timeout);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exitCode ?? -1,
        timedOut, signal: signal ?? null,
      });
    });
    if (input !== null) child.stdin.end(bytes(input, 'process stdin'));
    else child.stdin.end();
  });
}

/** Spawn the exact command/argv supplied by phase3-codex-executor and retain raw streams. */
export async function runProcess(command, args, context) {
  exactKeys(context, ['cwd', 'env', 'timeoutMilliseconds'], [], 'runProcess context');
  return collectProcess(command, args, context);
}

/** One isolated AIShell stdio session. No retry or alternate transport is attempted. */
export async function exchangeMCP({ binary, profile, stateDirectory, workspace, requestBytes }) {
  const timeoutMilliseconds = envTimeout('AISHELL_PHASE3_MCP_TIMEOUT_MS');
  const execution = await collectProcess(binary, [], {
    cwd: workspace,
    env: {
      ...process.env,
      AISHELL_STATE_DIRECTORY: stateDirectory,
      AISHELL_TOOL_PROFILE: profile,
    },
    timeoutMilliseconds,
    input: requestBytes,
  });
  if (execution.timedOut) throw new Error('AIShell MCP exchange timed out');
  if (execution.exitCode !== 0) throw new Error(`AIShell MCP exchange failed: exit=${execution.exitCode}, stderr=${execution.stderr.toString('utf8')}`);
  if (execution.stderr.length !== 0) throw new Error(`AIShell MCP wrote unexpected stderr: ${execution.stderr.toString('utf8')}`);
  return execution.stdout;
}

function jsonLines(raw, label) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes(raw, label)); }
  catch { throw new Error(`${label} must be UTF-8 JSONL`); }
  return text.split('\n').filter(Boolean).map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (!plainObject(value)) throw new Error();
      return value;
    } catch { throw new Error(`${label} line ${index + 1} is invalid`); }
  });
}

function mcpRequest(calls) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'aishell-phase3-local', version: '1' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    ...calls.map((call, index) => ({ jsonrpc: '2.0', id: index + 10, method: 'tools/call', params: call })),
  ];
  return Buffer.concat(messages.map((message) => Buffer.concat([canonicalJSONBytes(message), Buffer.from('\n')])));
}

async function localMCP({ attempt, armBinding, workspace, stateDirectory, calls }) {
  const binary = await verifiedArmBinary(attempt, armBinding);
  const profile = attempt.arm === 'candidate' ? 'expanded-v1' : 'development';
  const responseBytes = await exchangeMCP({
    binary, profile, stateDirectory, workspace, requestBytes: mcpRequest(calls),
  });
  const responses = jsonLines(responseBytes, 'AIShell MCP response');
  const initialize = responses.filter(({ id }) => id === 1);
  if (initialize.length !== 1 || initialize[0].result?.protocolVersion !== '2025-11-25' || initialize[0].error) {
    throw new Error('AIShell MCP initialize failed');
  }
  return calls.map((_call, index) => {
    const matches = responses.filter(({ id }) => id === index + 10);
    if (matches.length !== 1 || matches[0].error || !plainObject(matches[0].result)) {
      throw new Error(`AIShell MCP call ${index + 10} failed`);
    }
    const wrapper = matches[0].result;
    if (wrapper.isError !== false || !plainObject(wrapper.structuredContent)) {
      throw new Error(`AIShell MCP call ${index + 10} returned an error`);
    }
    return { wrapper, structured: wrapper.structuredContent, responseBytes };
  });
}

function snapshotCall(workspace) {
  return { name: 'workspace_snapshot', arguments: {
    path: workspace, project_profile: { mode: 'all', byte_budget: 262_144, profile_limit: 1_000 },
  } };
}

function profiles(snapshot) {
  if (!Array.isArray(snapshot.projectProfiles) || snapshot.projectProfileHasMore !== false) {
    throw new Error('complete project profile projection is unavailable');
  }
  if (snapshot.projectProfiles.some((profile) => profile?.projection === 'artifact_only')) {
    throw new Error('project profile projection is artifact-only');
  }
  return snapshot.projectProfiles;
}

async function exactFixtureCheck(profile, workspace) {
  const matches = (profile.checks ?? []).filter((check) =>
    Array.isArray(check.arguments) && check.arguments.length === 1 && check.arguments[0] === 'check.mjs');
  if (matches.length !== 1 || typeof matches[0].checkId !== 'string' || matches[0].checkId.length === 0) {
    throw new Error('exact fixture profile check is unavailable');
  }
  const check = matches[0];
  const canonicalWorkspace = await realpath(workspace);
  if (check.workingDirectory !== canonicalWorkspace) throw new Error('fixture profile check working directory is not the canonical workspace');
  let checkExecutable;
  let liveNode;
  try {
    [checkExecutable, liveNode] = await Promise.all([realpath(check.executable), realpath(process.execPath)]);
  } catch { throw new Error('fixture profile check executable is unavailable'); }
  if (checkExecutable !== liveNode) throw new Error('fixture profile check does not resolve to the live Node executable');
  const nodeInfo = await lstat(liveNode, { bigint: true });
  const nodeIdentity = `${nodeInfo.dev}:${nodeInfo.ino}`;
  const nodeSHA256 = sha256Hex(await readFile(liveNode));
  const toolchains = (await Promise.all((profile.toolchains ?? []).map(async (toolchain) => {
    try { return { toolchain, resolved: await realpath(toolchain.executable) }; }
    catch { return { toolchain, resolved: null }; }
  }))).filter(({ resolved }) => resolved === liveNode).map(({ toolchain }) => toolchain);
  if (toolchains.length !== 1 || toolchains[0].identity !== nodeIdentity || toolchains[0].sha256 !== nodeSHA256) {
    throw new Error('fixture profile executable identity/SHA does not match live Node');
  }
  const contract = check.inputContract;
  if (!plainObject(contract) || contract.schemaVersion !== 'aishell.project-profile-check-input.v1'
    || contract.completeness !== 'complete' || contract.effectCompleteness !== 'project_root_closed'
    || !Array.isArray(contract.includedRoots) || !Array.isArray(contract.trackedPaths)) {
    throw new Error('fixture profile relevant-input contract is missing or ineligible');
  }
  const declared = [...contract.includedRoots, ...contract.trackedPaths];
  const expected = ['check.mjs', 'src/value.mjs'];
  if (declared.length !== expected.length || new Set(declared).size !== expected.length
    || [...declared].sort().some((value, index) => value !== expected[index])) {
    throw new Error('fixture profile relevant-input contract does not exactly cover the frozen inputs');
  }
  for (const relative of expected) {
    const absolute = path.join(canonicalWorkspace, relative);
    const info = await lstat(absolute, { bigint: true });
    if (!info.isFile() || await realpath(absolute) !== absolute) {
      throw new Error(`frozen relevant input is not a canonical regular file: ${relative}`);
    }
    if (!SHA256.test(sha256Hex(await readFile(absolute)))) throw new Error(`frozen relevant input cannot be hashed: ${relative}`);
  }
  return check;
}

function validArtifact(artifact) {
  const fields = ['handle', 'kind', 'sizeBytes', 'lineCount', 'sha256', 'createdAt', 'expiresAt', 'producer'];
  if (!plainObject(artifact) || Object.keys(artifact).length !== fields.length
    || fields.some((key) => !Object.hasOwn(artifact, key))
    || typeof artifact.handle !== 'string' || artifact.handle.length === 0
    || typeof artifact.kind !== 'string' || artifact.kind.length === 0 || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes < 0 || !Number.isSafeInteger(artifact.lineCount) || artifact.lineCount < 0
    || !SHA256.test(artifact.sha256 ?? '') || typeof artifact.producer !== 'string') return false;
  const created = Date.parse(artifact.createdAt);
  const expires = Date.parse(artifact.expiresAt);
  return Number.isFinite(created) && Number.isFinite(expires) && expires > created;
}

function validateCandidateWarm(result, checkID) {
  exactKeys(result, ['schemaVersion', 'planDigest', 'selectionDigest', 'requestedCheckIDs', 'plannedCheckIDs',
    'cacheState', 'processesStarted', 'publications', 'steps', 'lookupEvidence'], [], 'candidate warm result');
  const step = result.steps?.[0];
  const lookup = result.lookupEvidence?.[0];
  exactKeys(step, ['stepID', 'terminalState', 'sourceRunID', 'stdoutArtifactSHA256', 'stderrArtifactSHA256',
    'artifacts', 'skippedBecauseDependencyFailed'], [], 'candidate warm step');
  exactKeys(lookup, ['stepID', 'status', 'ineligibilityReason'], [], 'candidate warm lookup evidence');
  if (result.schemaVersion !== 'aishell.run-check.v2' || !SHA256.test(result.planDigest ?? '')
    || !SHA256.test(result.selectionDigest ?? '') || result.cacheState !== 'miss_executed'
    || result.processesStarted !== 1 || result.publications !== 1
    || JSON.stringify(result.requestedCheckIDs) !== JSON.stringify([checkID])
    || JSON.stringify(result.plannedCheckIDs) !== JSON.stringify([checkID])
    || result.steps?.length !== 1 || step.stepID !== checkID || step.terminalState !== 'passed'
    || step.skippedBecauseDependencyFailed !== false || typeof step.sourceRunID !== 'string' || step.sourceRunID.length === 0
    || !SHA256.test(step.stdoutArtifactSHA256 ?? '') || !SHA256.test(step.stderrArtifactSHA256 ?? '')
    || !Array.isArray(step.artifacts) || step.artifacts.length < 2 || !step.artifacts.every(validArtifact)
    || !step.artifacts.some(({ sha256 }) => sha256 === step.stdoutArtifactSHA256)
    || !step.artifacts.some(({ sha256 }) => sha256 === step.stderrArtifactSHA256)
    || result.lookupEvidence?.length !== 1 || lookup.stepID !== checkID || lookup.status !== 'miss'
    || lookup.ineligibilityReason !== null) {
    throw new Error('candidate warm run did not execute and retain one successful freshness publication');
  }
}

function validateLegacyWarm(result) {
  exactKeys(result, ['schemaVersion', 'requestID', 'status', 'summary', 'exitCode', 'stdoutArtifact', 'stderrArtifact'],
    ['primaryDiagnostic', 'timedOut', 'durationMilliseconds'], 'legacy warm result');
  if (result.schemaVersion !== 'aishell.run-check.v1' || result.status !== 'passed' || result.exitCode !== 0
    || (Object.hasOwn(result, 'timedOut') && result.timedOut !== false)
    || typeof result.requestID !== 'string' || result.requestID.length === 0
    || typeof result.summary !== 'string' || result.summary.length === 0
    || (Object.hasOwn(result, 'durationMilliseconds')
      && (!Number.isSafeInteger(result.durationMilliseconds) || result.durationMilliseconds < 0))
    || !validArtifact(result.stdoutArtifact) || !validArtifact(result.stderrArtifact)) {
    throw new Error('legacy warm run did not return an exact successful retained result');
  }
}

async function validateStaticImportSetup(result, snapshot, workspace) {
  const freshness = result.freshness;
  const liveRoot = await rootBinding(workspace);
  const items = result.items;
  const reportItems = Array.isArray(items) ? items.filter(({ kind }) => kind === 'provider_report') : [];
  const staticReports = reportItems.filter(({ providerReport }) => providerReport?.descriptor?.providerID === 'static-import');
  const filesystemReports = reportItems.filter(({ providerReport }) =>
    providerReport?.descriptor?.providerID === 'aishell.filesystem-impact');
  const report = staticReports[0]?.providerReport;
  const filesystemReport = filesystemReports[0]?.providerReport;
  const candidates = Array.isArray(items) ? items.filter(({ kind }) => kind === 'candidate') : [];
  const evidence = Array.isArray(items) ? items.filter(({ kind }) => kind === 'evidence') : [];
  const edges = Array.isArray(items) ? items.filter(({ kind }) => kind === 'candidate_evidence') : [];
  const candidateIDs = new Set(candidates.map(({ candidateID }) => candidateID));
  const evidenceIDs = new Set(evidence.map(({ evidenceID }) => evidenceID));
  const linkedCandidates = new Set(edges.map(({ candidateID }) => candidateID));
  const linkedEvidence = new Set(edges.map(({ evidenceID }) => evidenceID));
  const input = Array.isArray(items) ? items.filter(({ kind }) => kind === 'input_path') : [];
  const inputSHA256 = sha256Hex(await readFile(path.join(workspace, 'src/a.mjs')));
  const dependentBytes = await readFile(path.join(workspace, 'src/b.mjs'));
  const dependentSHA256 = sha256Hex(dependentBytes);
  const testBytes = await readFile(path.join(workspace, 'test/b.test.mjs'));
  const testSHA256 = sha256Hex(testBytes);
  const tuple = (values) => values.map((value) => `${Buffer.byteLength(value)}:${value}`).join('');
  const expectedInputIdentity = tuple(['input_path', 'src/a.mjs', '0', inputSHA256]);
  const expectedImpacts = [
    {
      path: 'src/b.mjs', subjectKind: 'path', category: 'dependencies', bytes: dependentBytes,
      sha256: dependentSHA256, specifier: './a.mjs', target: 'src/a.mjs',
    },
    {
      path: 'test/b.test.mjs', subjectKind: 'test', category: 'related_tests', bytes: testBytes,
      sha256: testSHA256, specifier: '../src/b.mjs', target: 'src/b.mjs',
    },
  ];
  const exactImpact = expectedImpacts.every((expected) => {
    const matchingCandidates = candidates.filter(({ subject }) => subject?.path === expected.path);
    const matchingEvidence = evidence.filter(({ subject }) => subject?.path === expected.path);
    if (matchingCandidates.length !== 1 || matchingEvidence.length !== 1) return false;
    const candidate = matchingCandidates[0];
    const proof = matchingEvidence[0];
    const matchingEdges = edges.filter(({ candidateID, evidenceID }) =>
      candidateID === candidate.candidateID && evidenceID === proof.evidenceID);
    return candidate.category === expected.category && candidate.subject?.kind === expected.subjectKind
      && proof.providerID === 'static-import' && proof.subject?.kind === expected.subjectKind
      && proof.inputIdentity === expectedInputIdentity && proof.relation === 'declared_dependency'
      && proof.locator?.path === expected.path && proof.locator?.contentSHA256 === expected.sha256
      && Number.isSafeInteger(proof.locator?.startOffset) && proof.locator.startOffset >= 0
      && Number.isSafeInteger(proof.locator?.endOffset) && proof.locator.endOffset > proof.locator.startOffset
      && expected.bytes.subarray(proof.locator.startOffset, proof.locator.endOffset).toString('utf8') === expected.specifier
      && proof.locator.edgeID === tuple([expected.path, expected.target])
      && proof.evidenceStrength === 'declared_edge' && matchingEdges.length === 1;
  });
  const categories = ['references', 'dependencies', 'related_tests', 'build_targets'];
  if (result.schemaVersion !== 'aishell.change-impact.v2' || result.operation !== 'analyze'
    || result.coverage !== 'complete' || !plainObject(freshness)
    || freshness.rootIdentity !== liveRoot.identity || freshness.inputCursor !== snapshot.cursor
    || freshness.observedCursor !== snapshot.cursor || !SHA256.test(freshness.bindingDigest ?? '')
    || !Number.isSafeInteger(freshness.bindingCount) || freshness.bindingCount < 1
    || reportItems.length !== 2 || staticReports.length !== 1 || report?.descriptor?.providerID !== 'static-import'
    || report.descriptor.kind !== 'lexical_search' || report.descriptor.version !== '1'
    || report.status !== 'fresh' || !SHA256.test(report.inputDigest ?? '')
    || report.observedAtCursor !== snapshot.cursor
    || filesystemReports.length !== 1 || filesystemReport?.descriptor?.kind !== 'lexical_search'
    || filesystemReport.descriptor.version !== '1' || filesystemReport.status !== 'fresh'
    || !SHA256.test(filesystemReport.inputDigest ?? '') || filesystemReport.observedAtCursor !== snapshot.cursor
    || input.length !== 1 || input[0].changedPath?.path !== 'src/a.mjs'
    || input[0].changedPath?.contentSHA256 !== inputSHA256 || input[0].changedPath?.expectedAbsent !== false
    || !items.some(({ kind, providerID }) => kind === 'required_provider' && providerID === 'static-import')
    || items.some(({ kind }) => kind === 'coverage_gap')
    || candidates.length !== 2 || candidateIDs.size !== 2 || evidence.length !== 2 || evidenceIDs.size !== 2
    || edges.length !== 2 || !exactImpact
    || edges.some(({ candidateID, evidenceID }) => !candidateIDs.has(candidateID) || !evidenceIDs.has(evidenceID))
    || candidates.some(({ candidateID }) => !linkedCandidates.has(candidateID))
    || evidence.some(({ evidenceID }) => !linkedEvidence.has(evidenceID)) || !plainObject(result.counts)
    || categories.some((category) => result.counts[category === 'related_tests' ? 'relatedTests'
      : category === 'build_targets' ? 'buildTargets' : category]
      !== candidates.filter((candidate) => candidate.category === category).length)
    || result.hasMore !== false || result.continuation !== null || result.omittedBytes !== 0
    || !Number.isSafeInteger(result.returnedBytes) || result.returnedBytes < 1 || !validArtifact(result.artifact)
    || result.artifact.sizeBytes !== result.returnedBytes) {
    throw new Error('static-import setup did not return complete fresh candidate/evidence semantics');
  }
}

/** Execute the two non-mutation frozen setup actions against the same runtime state directory. */
export async function runSetupStep({ attempt, armBinding, workspace, stateDirectory, step }) {
  if (step === 'execute the check once and retain its freshness inputs') {
    if (attempt.arm === 'native') {
      const result = await collectProcess(process.execPath, ['check.mjs'], {
        cwd: workspace, env: process.env, timeoutMilliseconds: envTimeout('AISHELL_PHASE3_SETUP_TIMEOUT_MS'),
      });
      if (result.timedOut || result.exitCode !== 0) throw new Error('native warm check failed');
      return { schema: 'aishell.phase3-local-setup-step.v1', step, processCount: 1 };
    }
    if (attempt.arm === 'candidate') {
      const [snapshot] = await localMCP({ attempt, armBinding, workspace, stateDirectory, calls: [snapshotCall(workspace)] });
      const catalog = profiles(snapshot.structured);
      if (catalog.length !== 1) throw new Error('fixture must resolve to exactly one project profile');
      const profile = catalog[0];
      const check = await exactFixtureCheck(profile, workspace);
      const [warm] = await localMCP({ attempt, armBinding, workspace, stateDirectory, calls: [{ name: 'run_check', arguments: {
        schema: 'aishell.run-check.v2',
        invocation: { mode: 'profile_check', project_id: profile.projectId, profile_digest: profile.profileDigest, check_id: check.checkId },
        dispatch: { mode: 'sync' }, cache: 'prefer',
        execution_policy: { timeout_ms: envTimeout('AISHELL_PHASE3_SETUP_TIMEOUT_MS'), retention_seconds: 3_600 },
        selection: { binding: 'prepare' },
      } }] });
      validateCandidateWarm(warm.structured, check.checkId);
      return { schema: 'aishell.phase3-local-setup-step.v1', step, processCount: 1, structuredResult: warm.structured };
    } else if (attempt.arm === 'current-aishell-0.3.3') {
      const [warm] = await localMCP({ attempt, armBinding, workspace, stateDirectory, calls: [{ name: 'run_check', arguments: {
        executable: process.execPath, arguments: ['check.mjs'], working_directory: workspace,
      } }] });
      validateLegacyWarm(warm.structured);
      return { schema: 'aishell.phase3-local-setup-step.v1', step, processCount: 1, structuredResult: warm.structured };
    } else {
      throw new Error(`unsupported warm-check arm: ${attempt.arm}`);
    }
    return { schema: 'aishell.phase3-local-setup-step.v1', step, processCount: 1 };
  }
  if (step === 'index static imports') {
    if (attempt.arm !== 'candidate') return { schema: 'aishell.phase3-local-setup-step.v1', step, processCount: 0 };
    const file = path.join(workspace, 'src/a.mjs');
    const contentSHA256 = sha256Hex(await readFile(file));
    const [snapshot] = await localMCP({ attempt, armBinding, workspace, stateDirectory, calls: [snapshotCall(workspace)] });
    const [analysis] = await localMCP({ attempt, armBinding, workspace, stateDirectory, calls: [{ name: 'change_impact', arguments: {
      operation: 'analyze', root: workspace, workspace_cursor: snapshot.structured.cursor,
      changed_paths: [{ path: 'src/a.mjs', content_sha256: contentSHA256 }],
      required_providers: ['static-import'], byte_budget: 1_048_576,
    } }] });
    await validateStaticImportSetup(analysis.structured, snapshot.structured, workspace);
    return { schema: 'aishell.phase3-local-setup-step.v1', step, processCount: 0, structuredResult: analysis.structured };
  }
  throw new Error(`unsupported local setup step: ${step}`);
}

async function rootBinding(workspace) {
  const canonical = await realpath(workspace);
  const info = await lstat(canonical, { bigint: true });
  return { root: canonical, identity: `${info.dev}:${info.ino}` };
}

/** Capture only live FS/MCP identities. Missing profiles are blockers, never synthesized. */
export async function captureTrustedSetup({ attempt, armBinding, workspace, stateDirectory }) {
  if (attempt.arm !== 'candidate') return {};
  const [snapshotResult] = await localMCP({ attempt, armBinding, workspace, stateDirectory, calls: [snapshotCall(workspace)] });
  const snapshot = snapshotResult.structured;
  if (typeof snapshot.cursor !== 'string' || snapshot.cursor.length === 0) throw new Error('workspace cursor is unavailable');
  const taskID = attempt.taskID;
  if (taskID.startsWith('freshness-cache-')) {
    const catalog = profiles(snapshot);
    if (catalog.length !== 1) throw new Error('freshness fixture has no exact production project profile');
    const profile = catalog[0];
    const check = await exactFixtureCheck(profile, workspace);
    const frozen = { action: 'execute', executable: 'node', arguments: ['check.mjs'], freshness_inputs: ['check.mjs', 'src/value.mjs'] };
    return { run_check: {
      schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'run_check',
      profileCheck: {
        projectID: profile.projectId, profileDigest: profile.profileDigest, checkID: check.checkId,
        frozenBindingDigest: frozenRunCheckBindingDigest(frozen),
      },
      cache: 'prefer', selection: { binding: 'prepare' },
      executionPolicy: { timeoutMs: envTimeout('AISHELL_PHASE3_SETUP_TIMEOUT_MS'), retentionSeconds: 3_600 },
    } };
  }
  const changedPath = taskID === 'change-impact-unresolved-edge' ? 'src/dynamic.mjs' : 'src/a.mjs';
  let binding;
  try { binding = { path: changedPath, contentSHA256: sha256Hex(await readFile(path.join(workspace, changedPath))) }; }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    binding = { path: changedPath, expectedAbsent: true };
  }
  const liveRoot = await rootBinding(workspace);
  const setup = {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', root: liveRoot.root,
    rootIdentity: liveRoot.identity, workspaceCursor: snapshot.cursor,
    pathBindings: [binding], providerIDs: ['static-import'],
  };
  if (taskID.startsWith('focused-pipeline-')) {
    const catalog = profiles(snapshot);
    if (catalog.length !== 1) throw new Error('focused fixture has no exact production project profile');
    setup.projectID = catalog[0].projectId;
    setup.profileDigest = catalog[0].profileDigest;
  }
  return { change_impact: setup };
}

function exactBase64(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} base64 is required`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`${label} base64 is invalid`);
  return decoded;
}

function parseExactJSON(value, rawBytes, label) {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)); }
  catch { throw new Error(`${label} bytes are invalid JSON`); }
  if (!canonicalJSONBytes(parsed).equals(canonicalJSONBytes(value))) throw new Error(`${label} bytes/object mismatch`);
  return parsed;
}

function splitExactJSONLines(rawBytes, label) {
  const raw = bytes(rawBytes, label);
  const records = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0x0a) continue;
    let end = index;
    if (end > start && raw[end - 1] === 0x0d) end -= 1;
    if (end > start) {
      const lineBytes = raw.subarray(start, end);
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lineBytes)); }
      catch { throw new Error(`${label} contains invalid JSONL`); }
      if (!plainObject(value)) throw new Error(`${label} JSONL record must be an object`);
      records.push({ value, bytes: lineBytes });
    }
    start = index + 1;
  }
  return records;
}

function skipWhitespace(raw, offset) {
  let index = offset;
  while (index < raw.length && [0x20, 0x09, 0x0a, 0x0d].includes(raw[index])) index += 1;
  return index;
}

function skipJSONString(raw, offset) {
  if (raw[offset] !== 0x22) throw new Error('expected JSON string');
  let index = offset + 1;
  while (index < raw.length) {
    if (raw[index] === 0x5c) { index += 2; continue; }
    if (raw[index] === 0x22) return index + 1;
    index += 1;
  }
  throw new Error('unterminated JSON string');
}

function skipJSONValue(raw, offset) {
  const start = skipWhitespace(raw, offset);
  if (raw[start] === 0x22) return skipJSONString(raw, start);
  if (raw[start] === 0x7b || raw[start] === 0x5b) {
    const open = raw[start];
    const close = open === 0x7b ? 0x7d : 0x5d;
    let depth = 1;
    let index = start + 1;
    while (index < raw.length) {
      if (raw[index] === 0x22) { index = skipJSONString(raw, index); continue; }
      if (raw[index] === open) depth += 1;
      else if (raw[index] === close && --depth === 0) return index + 1;
      index += 1;
    }
    throw new Error('unterminated JSON container');
  }
  let index = start;
  while (index < raw.length && ![0x2c, 0x5d, 0x7d, 0x20, 0x09, 0x0a, 0x0d].includes(raw[index])) index += 1;
  if (index === start) throw new Error('invalid JSON value');
  return index;
}

function exactObjectMember(rawBytes, key, label) {
  const raw = bytes(rawBytes, label);
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== 0x7b) throw new Error(`${label} must be a JSON object`);
  index = skipWhitespace(raw, index + 1);
  while (index < raw.length && raw[index] !== 0x7d) {
    const keyStart = index;
    const keyEnd = skipJSONString(raw, keyStart);
    let parsedKey;
    try { parsedKey = JSON.parse(raw.subarray(keyStart, keyEnd).toString('utf8')); }
    catch { throw new Error(`${label} has an invalid member name`); }
    index = skipWhitespace(raw, keyEnd);
    if (raw[index] !== 0x3a) throw new Error(`${label} has an invalid member separator`);
    const valueStart = skipWhitespace(raw, index + 1);
    const valueEnd = skipJSONValue(raw, valueStart);
    if (parsedKey === key) return raw.subarray(valueStart, valueEnd);
    index = skipWhitespace(raw, valueEnd);
    if (raw[index] === 0x2c) index = skipWhitespace(raw, index + 1);
    else if (raw[index] !== 0x7d) throw new Error(`${label} has an invalid object delimiter`);
  }
  throw new Error(`${label} is missing ${key}`);
}

async function exactWireToolCalls(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('MCP wire directory is unavailable');
  const [requestBytes, responseBytes] = await Promise.all([
    readFile(path.join(directory, 'requests.bin')),
    readFile(path.join(directory, 'responses.bin')),
  ]);
  const requests = splitExactJSONLines(requestBytes, 'MCP request wire');
  const responses = splitExactJSONLines(responseBytes, 'MCP response wire');
  const responseByID = new Map();
  for (const response of responses) {
    const id = JSON.stringify(response.value.id);
    if (responseByID.has(id)) throw new Error('MCP response id is duplicated');
    responseByID.set(id, response);
  }
  return requests.filter(({ value }) => value.method === 'tools/call').map((request, index) => {
    const response = responseByID.get(JSON.stringify(request.value.id));
    if (!response || response.value.error || !plainObject(response.value.result)) throw new Error(`MCP wire call ${index} failed`);
    const wrapper = response.value.result;
    if (wrapper.isError !== false || !plainObject(wrapper.structuredContent)) throw new Error(`MCP wire call ${index} returned an error`);
    const resultObjectBytes = exactObjectMember(response.bytes, 'result', `MCP response ${index}`);
    const resultBytes = exactObjectMember(resultObjectBytes, 'structuredContent', `MCP response ${index} result`);
    parseExactJSON(wrapper.structuredContent, resultBytes, `MCP wire call ${index} structured result`);
    const params = request.value.params;
    if (!plainObject(params) || typeof params.name !== 'string' || !plainObject(params.arguments)) {
      throw new Error(`MCP wire call ${index} request is invalid`);
    }
    return { tool: params.name, request: params.arguments, result: wrapper.structuredContent, resultBytes, wrapper };
  });
}

function rawToolCalls(events) {
  return events.filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call');
}

async function observedToolCalls(events, mcpWireDirectory) {
  const hostCalls = rawToolCalls(events);
  if (mcpWireDirectory === undefined) {
    return hostCalls.map((event, index) => {
      const item = event.item;
      exactKeys(item, ['type', 'server', 'tool', 'arguments', 'result', 'result_bytes_base64', 'status'],
        ['raw_pages', 'complete_artifact_base64'], `Codex MCP call ${index}`);
      if (item.server !== 'aishell' || item.status !== 'completed' || !plainObject(item.arguments) || !plainObject(item.result)) {
        throw new Error(`Codex MCP call ${index} is unsupported`);
      }
      const resultBytes = exactBase64(item.result_bytes_base64, `Codex MCP call ${index} result`);
      parseExactJSON(item.result, resultBytes, `Codex MCP call ${index} result`);
      return { tool: item.tool, request: item.arguments, result: item.result, resultBytes, item };
    });
  }
  const wireCalls = await exactWireToolCalls(mcpWireDirectory);
  if (hostCalls.length !== wireCalls.length) throw new Error('Codex MCP event/wire call count differs');
  hostCalls.forEach((event, index) => {
    const item = event.item;
    const call = wireCalls[index];
    if (item.server !== 'aishell' || item.status !== 'completed' || item.tool !== call.tool
      || !canonicalJSONBytes(item.arguments).equals(canonicalJSONBytes(call.request))) {
      throw new Error(`Codex MCP event/wire call ${index} differs`);
    }
  });
  return wireCalls;
}

function observerMetrics(events, calls, attempt) {
  const turns = events.filter(({ type }) => type === 'turn.completed').length;
  const results = calls.map(({ result }) => result);
  return {
    firstUsefulResultMilliseconds: null,
    toolCalls: calls.length,
    modelTurns: turns,
    retries: events.filter(({ type }) => type === 'turn.failed').length,
    artifactRereads: calls.filter(({ tool }) => tool === 'artifact_read').length,
    filesystemEntriesRescanned: results.reduce((sum, result) => sum + (result.fullRescans ?? 0), 0),
    bytesReread: results.reduce((sum, result) => sum + (result.returnedBytes ?? 0), 0),
    processReexecutions: results.reduce((sum, result) => sum + (result.processesStarted ?? 0), 0),
    cacheHits: results.filter((result) => result.cacheState === 'hit' || result.cacheHit === true).length,
    changeJournalHits: results.filter((result) => result.changeJournalHit === true).length,
    toolAdoption: attempt.arm === 'candidate' && calls.length > 0,
  };
}

/** Parse Codex JSONL/MCP results without accepting lossy strings or unknown call shapes. */
export async function collectAttemptEvidence(input) {
  const { attempt, workspace, stateDirectory, preAttemptManifest, baselineManifest,
    benchmarkSetupEvidence, trustedProductionSetup, agentEvents, finalAgent, execution, mcpWireDirectory } = input;
  if (!Array.isArray(agentEvents)) throw new Error('Codex agent events are missing');
  const calls = await observedToolCalls(agentEvents, mcpWireDirectory);
  const observerEvents = [];
  let adapterTraceBytes = null;
  let projectedResult = {};
  if (attempt.arm === 'candidate') {
    const prepared = await prepareCandidateRequests({
      taskId: attempt.taskID, workspaceRoot: workspace, preAttemptManifest, baselineManifest,
      setupEvidence: benchmarkSetupEvidence, trustedProductionSetup,
    });
    const preparedCall = prepared.calls[0];
    const primaryCalls = calls.filter(({ tool }) => tool === preparedCall.tool);
    if (primaryCalls.length === 0 || primaryCalls.length !== calls.length) {
      throw new Error('candidate attempt contains missing or unrelated AIShell wire calls');
    }
    const call = primaryCalls[0];
    if (call.tool !== preparedCall.tool || !canonicalJSONBytes(call.request).equals(preparedCall.productionRequestBytes)) {
      throw new Error('candidate tool call differs from the production adapter request');
    }
    let recorded;
    let artifact = Buffer.alloc(0);
    if (call.tool === 'run_check') {
      if (primaryCalls.length !== 1) throw new Error('candidate run_check attempt must contain exactly one result');
      recorded = recordCandidateProjection({
        preparedCall, trustedSetupEvidence: trustedProductionSetup[call.tool],
        productionResult: call.result, productionResultBytes: call.resultBytes,
      });
    } else {
      let pages;
      if (mcpWireDirectory === undefined) {
        if (!Array.isArray(call.item.raw_pages) || call.item.raw_pages.length === 0) throw new Error('change_impact exact raw pages are missing');
        pages = call.item.raw_pages.map((page, index) => {
          exactKeys(page, ['result', 'result_bytes_base64'], ['requestToken'], `raw page ${index}`);
          const resultBytes = exactBase64(page.result_bytes_base64, `raw page ${index}`);
          parseExactJSON(page.result, resultBytes, `raw page ${index}`);
          return { ...(Object.hasOwn(page, 'requestToken') ? { requestToken: page.requestToken } : {}), result: page.result, resultBytes };
        });
        artifact = exactBase64(call.item.complete_artifact_base64, 'complete change_impact artifact');
      } else {
        pages = primaryCalls.map((page, index) => {
          if (index > 0) {
            const expectedToken = primaryCalls[index - 1].result.continuation;
            if (typeof expectedToken !== 'string' || page.request.continuation !== expectedToken
              || Object.keys(page.request).some((key) => !['continuation', 'byte_budget'].includes(key))) {
              throw new Error(`change_impact wire page ${index} has an invalid continuation request`);
            }
          }
          return { ...(index > 0 ? { requestToken: page.request.continuation } : {}), result: page.result, resultBytes: page.resultBytes };
        });
        const descriptor = call.result.artifact;
        if (!validArtifact(descriptor)) throw new Error('change_impact wire artifact descriptor is invalid');
        artifact = await readFile(path.join(stateDirectory, 'evidence', `${descriptor.handle}.data`));
        if (artifact.length !== descriptor.sizeBytes || sha256Hex(artifact) !== descriptor.sha256) {
          throw new Error('change_impact retained artifact differs from its wire descriptor');
        }
      }
      const projected = projectProductionV2Result({
        tool: call.tool, frozenRequest: preparedCall.frozenRequest,
        rawV2Pages: pages.map(({ result, requestToken }, index) => ({
          ...(index > 0 ? { requestToken } : {}), result,
        })),
        completeArtifactBytes: artifact,
      });
      const projectedBytes = canonicalJSONBytes(projected);
      recorded = {
        projected, projectedBytes, productionResultBytes: call.resultBytes,
        trace: buildBenchmarkTrace({
          v1RequestBytes: preparedCall.frozenRequestBytes,
          trustedSetupEvidence: trustedProductionSetup[call.tool],
          v2RequestBytes: preparedCall.productionRequestBytes,
          rawV2Pages: pages, completeArtifactBytes: artifact, projectedV1Bytes: projectedBytes,
        }),
      };
    }
    projectedResult = recorded.projected;
    adapterTraceBytes = candidateAdapterTraceBytes({
      attemptID: attempt.attemptID, taskID: attempt.taskID, preparedCall,
      benchmarkSetupEvidence, trustedSetupEvidence: trustedProductionSetup[call.tool],
      productionResultBytes: recorded.productionResultBytes, trace: recorded.trace,
      completeArtifactBytes: artifact, projectedResultBytes: recorded.projectedBytes,
    });
    observerEvents.push({
      provider: 'aishell', tool: preparedCall.tool, action: preparedCall.action,
      request: preparedCall.frozenRequest,
      metadata: { preStateDigest: preAttemptManifest.digest },
      result: recorded.projected, resultDigest: sha256Hex(canonicalJSONBytes(recorded.projected)),
      status: 'succeeded', isError: false,
    });
  } else {
    for (const call of calls) {
      const action = call.request.action ?? (call.tool === 'run_check' ? 'execute' : call.request.operation);
      if (typeof action !== 'string') throw new Error('legacy/local tool action is unavailable');
      observerEvents.push({
        provider: 'aishell', tool: call.tool, action, request: call.request,
        metadata: { preStateDigest: preAttemptManifest.digest }, result: call.result,
        resultDigest: sha256Hex(canonicalJSONBytes(call.result)), status: 'succeeded', isError: false,
      });
    }
    projectedResult = Object.assign({}, ...calls.map(({ result }) => result));
  }
  if (!plainObject(finalAgent?.assertions)) throw new Error('final agent assertions are unavailable');
  const telemetry = Object.assign({}, ...calls.map(({ result }) => ({
    ...(Number.isInteger(result.processesStarted) ? { secondExecutionCount: result.processesStarted } : {}),
    ...(typeof result.cacheHit === 'boolean' ? { cacheHit: result.cacheHit } : {}),
    ...(Number.isInteger(result.falseFresh) ? { falseFresh: result.falseFresh } : {}),
  })));
  return {
    result: Object.keys(projectedResult).length === 0 ? structuredClone(finalAgent.assertions) : projectedResult,
    process: { agentExitCode: execution.exitCode, agentTimedOut: execution.timedOut },
    artifactStore: path.join(stateDirectory, 'evidence'), telemetry, trace: {},
    toolTrace: { events: observerEvents }, metrics: observerMetrics(agentEvents, calls, attempt),
    adapterTraceBytes,
  };
}

/** Actual provider metadata bytes are mandatory; requested model configuration is never read. */
export async function observeProviderModel({ providerTraceBytes, providerSSEBytes }) {
  const trace = bytes(providerTraceBytes, 'provider trace');
  const sse = bytes(providerSSEBytes, 'provider SSE trace');
  const responseEvents = jsonLines(sse, 'provider SSE trace');
  if (responseEvents.some(({ type }) => type !== 'response.created' && type !== 'response.completed')) {
    throw new Error('provider SSE trace contains unrelated events');
  }
  const completed = responseEvents.filter(({ type }) => type === 'response.completed');
  const models = new Set(responseEvents.map(({ response }) => response?.model));
  if (completed.length === 0 || models.size !== 1 || typeof [...models][0] !== 'string' || [...models][0].length === 0) {
    throw new Error('actual provider model snapshot is unavailable or inconsistent');
  }
  return canonicalJSONBytes({
    schema: 'aishell.provider-model-evidence.v1', source: 'codex-provider-sse',
    modelSnapshot: [...models][0], providerTraceSHA256: sha256Hex(trace), providerSSETraceSHA256: sha256Hex(sse),
  });
}
