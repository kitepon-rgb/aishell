#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assemblePhase3Result,
  buildPhase3AttemptManifest,
  candidateAdapterTraceBytes,
  extractProviderModelsFromSSETrace,
  runPhase3Attempts,
  validatePhase3Result,
} from './phase3-representative-runner.mjs';
import { createPhase3CodexExecutor } from './phase3-codex-executor.mjs';
import {
  adaptFrozenCapabilityRequest,
  buildBenchmarkTrace,
  canonicalJSONBytes,
  frozenRunCheckBindingDigest,
  projectProductionV2Result,
  sha256Hex,
} from './production-v2-benchmark-adapter.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const root = await mkdtemp(path.join(tmpdir(), 'aishell-phase3-executor-test-'));
const outputDirectory = path.join(root, 'runs');
const currentBinary = path.join(root, 'current-aishell');
const candidateBinary = path.join(root, 'candidate-aishell');
await writeFile(currentBinary, 'current');
await writeFile(candidateBinary, 'candidate');
await chmod(currentBinary, 0o755);
await chmod(candidateBinary, 0o755);
const configuration = {
  schema: 'aishell.phase3-run-configuration.v1', provider: 'fixture-provider',
  modelSnapshot: 'fixture-model-snapshot', reasoningEffort: 'high',
  sandbox: { approvalPolicy: 'on-request', filesystem: 'workspace-write', network: false },
  commonHostCatalogDigest: digest('host-catalog'),
  approvalReviewer: { mode: 'auto_review', modelSnapshots: ['fixture-reviewer-model'] },
  armBindings: {
    native: { binding: 'native', aishellBinaryDigest: null, aishellToolCatalogDigest: null },
    'current-aishell-0.3.3': {
      binding: 'current', aishellBinaryDigest: sha256Hex(await readFile(currentBinary)), aishellToolCatalogDigest: digest('current-tools'),
    },
    candidate: {
      binding: 'candidate', aishellBinaryDigest: sha256Hex(await readFile(candidateBinary)), aishellToolCatalogDigest: digest('candidate-tools'),
    },
  },
};
const manifest = await buildPhase3AttemptManifest(configuration);
const selected = Object.fromEntries(['native', 'current-aishell-0.3.3', 'candidate'].map((arm) => [
  arm, manifest.attempts.find((attempt) => attempt.taskID === 'freshness-cache-input-change' && attempt.arm === arm),
]));
const invocations = [];
let timedOut = false;
let omitUsage = false;
let incompleteSSE = false;

async function setupAttempt({ attempt, workspace, frozen, applyFrozenMutation }) {
  assert.equal(frozen.task.id, attempt.taskID);
  assert.equal(Object.hasOwn(frozen, 'scenario'), false, 'setup DTO must not contain the scenario object');
  assert.equal(Object.hasOwn(frozen, 'oracle'), false);
  assert.equal(Object.hasOwn(frozen.fixture, 'scenarios'), false);
  assert.equal(JSON.stringify(frozen).includes('"oracle"'), false);
  assert.equal(Array.isArray(frozen.mutation), true);
  assert.deepEqual(frozen.contract.setupSteps, [
    'materialize fixture', 'execute the check once and retain its freshness inputs', 'apply the frozen source mutation',
  ]);
  assert.equal(await readFile(path.join(workspace, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  await applyFrozenMutation();
  assert.equal(await readFile(path.join(workspace, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
  return { schema: 'fixture-setup.v1', taskID: attempt.taskID, workspace };
}

function providerEvents(taskID) {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }),
    JSON.stringify({ type: 'provider.metadata', model_snapshot: configuration.modelSnapshot }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', name: 'run_check', status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ schema: 'aishell.agent-benchmark-report.v1', taskId: taskID, assertions: {} }) } }),
  ];
  if (!omitUsage) events.push(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 },
  }));
  return Buffer.from(events.join('\n') + '\n');
}

async function runProcess(command, args, context) {
  invocations.push({ command, args, context });
  const reviewerCompleted = { type: 'response.completed', response: {
    id: 'reviewer-response', model: configuration.approvalReviewer.modelSnapshots[0],
    ...(!omitUsage ? { usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } } } : {}),
  } };
  const mainCompleted = { type: 'response.completed', response: {
    id: 'main-response', model: configuration.modelSnapshot,
    ...(!omitUsage ? { usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } } : {}),
  } };
  const stderrLines = [
    `TRACE tungstenite::protocol: Received message ${JSON.stringify({ type: 'response.created', response: { id: 'reviewer-response', model: configuration.approvalReviewer.modelSnapshots[0] } })}`,
    `TRACE tungstenite::protocol: Received message ${JSON.stringify(reviewerCompleted)}`,
    `TRACE tungstenite::protocol: Received message ${JSON.stringify({ type: 'response.created', response: { id: 'main-response', model: configuration.modelSnapshot } })}`,
  ];
  if (!incompleteSSE) stderrLines.push(`TRACE tungstenite::protocol: Received message ${JSON.stringify(mainCompleted)}`);
  stderrLines.push('fixture diagnostic', '');
  const stderr = Buffer.from(stderrLines.join('\n'));
  return { stdout: providerEvents(selected.native.taskID), stderr, exitCode: 0, timedOut };
}

async function observeAttempt({ attempt, workspace, mcpWireDirectory, toolTrace, finalAgent }) {
  assert.equal(finalAgent.taskId, attempt.taskID);
  assert.equal(toolTrace.events.length, 1);
  assert.equal((await stat(workspace)).isDirectory(), true);
  assert.equal(mcpWireDirectory === undefined, attempt.arm === 'native');
  if (attempt.arm !== 'native') assert.equal(mcpWireDirectory.endsWith('/mcp-wire'), true);
  return {
    observerEvidence: { schema: 'fixture-observer.v1', attemptID: attempt.attemptID },
    adapterTraceBytes: attempt.arm === 'candidate' ? Buffer.from('{"fixture":"adapter"}') : null,
  };
}

async function observeToolCatalog({ binary, profile, workspace, stateDirectory }) {
  assert.equal(path.isAbsolute(binary), true);
  assert.equal(path.isAbsolute(workspace), true);
  assert.equal(path.isAbsolute(stateDirectory), true);
  return profile === 'expanded-v1' ? digest('candidate-tools') : digest('current-tools');
}

async function observeProviderModel(input) {
  assert.deepEqual(Object.keys(input).sort(), ['approvalReviewer', 'mainModelSnapshot', 'providerSSEBytes', 'providerTraceBytes']);
  const models = extractProviderModelsFromSSETrace(input.providerSSEBytes);
  return canonicalJSONBytes({
    schema: 'aishell.provider-model-evidence.v3', source: 'codex-provider-sse', models,
    providerTraceSHA256: sha256Hex(input.providerTraceBytes),
    providerSSETraceSHA256: sha256Hex(input.providerSSEBytes),
  });
}

function executorOptions(overrides = {}) {
  return {
    outputDirectory: path.join(root, `options-${digest(JSON.stringify(overrides)).slice(0, 12)}`),
    armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: candidateBinary },
    sandboxConfiguration: configuration.sandbox,
    approvalReviewer: configuration.approvalReviewer,
    commonHostCatalogDigest: configuration.commonHostCatalogDigest,
    commonCodexArguments: [], setupAttempt, observeToolCatalog, observeProviderModel, observeAttempt, runProcess,
    ...overrides,
  };
}

for (const commonCodexArguments of [
  ['--model', 'wrong-model'],
  ['--config', 'model_reasoning_effort="low"'],
  ['--config=mcp_servers.aishell.command="wrong"'],
  ['--config', 'approval_policy="on-request"'],
  ['--sandbox=read-only'],
  ['--cd', '/tmp/wrong-root'],
  ['--add-dir', '/tmp/extra-root'],
]) {
  assert.throws(() => createPhase3CodexExecutor(executorOptions({ commonCodexArguments })), /may not override benchmark/u);
}
assert.throws(() => createPhase3CodexExecutor(executorOptions({
  sandboxConfiguration: { approvalPolicy: 'never', filesystem: 'disposable', network: false },
})), /no exact Codex argv mapping/u);
assert.throws(() => createPhase3CodexExecutor(executorOptions({
  sandboxConfiguration: { approvalPolicy: 'bypass', filesystem: 'workspace-write', network: false },
})), /no exact Codex argv mapping/u);
assert.throws(() => createPhase3CodexExecutor(executorOptions({
  outputDirectory: path.resolve(new URL('..', import.meta.url).pathname, 'nested-benchmark-output'),
})), /outside every Git worktree/u);

const executor = createPhase3CodexExecutor({
  outputDirectory,
  armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: candidateBinary },
  sandboxConfiguration: configuration.sandbox,
  approvalReviewer: configuration.approvalReviewer,
  commonHostCatalogDigest: configuration.commonHostCatalogDigest,
  commonCodexArguments: ['--config', 'fixture_host_catalog=true'],
  setupAttempt, observeToolCatalog, observeProviderModel, observeAttempt, runProcess, timeoutMilliseconds: 300_000,
});

for (const arm of ['native', 'current-aishell-0.3.3', 'candidate']) {
  const attempt = selected[arm];
  const record = await executor({
    attempt, isolation: manifest.isolation, armBinding: manifest.armBindings[arm],
    prompt: await renderRepresentativePrompt(attempt.taskID),
  });
  assert.equal(record.arm, arm);
  assert.deepEqual(record.usage, {
    source: 'provider', inputTokens: 12, cachedInputTokens: 0,
    outputTokens: 5, reasoningOutputTokens: 0, totalModelTokens: 17,
  });
  assert.equal(record.providerUsageFormat, 'codex-provider-sse-jsonl.v1');
  assert.deepEqual(record.providerModels, [
    { modelSnapshot: configuration.modelSnapshot, responseCount: 1 },
    { modelSnapshot: configuration.approvalReviewer.modelSnapshots[0], responseCount: 1 },
  ].sort((left, right) => left.modelSnapshot.localeCompare(right.modelSnapshot)));
  assert.equal(record.adapterTrace !== null, arm === 'candidate');
  assert.equal(record.providerTrace.byteLength > 0, true);
  assert.equal(JSON.parse(await readFile(path.join(outputDirectory, attempt.attemptID, 'observer-evidence.json'))).attemptID, attempt.attemptID);
  const bindings = JSON.parse(await readFile(path.join(outputDirectory, attempt.attemptID, 'observed-bindings.json')));
  assert.equal(bindings.requestedModelSnapshot, configuration.modelSnapshot);
  assert.deepEqual(bindings.actualProviderModels, record.providerModels);
  const modelEvidence = await readFile(path.join(outputDirectory, attempt.attemptID, 'provider-model-evidence.json'));
  assert.deepEqual(JSON.parse(modelEvidence).models, record.providerModels);
  const providerSSE = (await readFile(path.join(outputDirectory, attempt.attemptID, 'provider-sse.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(providerSSE.map(({ type }) => type), [
    'response.created', 'response.completed', 'response.created', 'response.completed',
  ]);
  assert.equal(await readFile(path.join(outputDirectory, attempt.attemptID, 'stderr.log'), 'utf8'), 'fixture diagnostic\n');
  const invocation = JSON.parse(await readFile(path.join(outputDirectory, attempt.attemptID, 'codex-invocation.json')));
  assert.deepEqual(invocation.environmentBindings, { GIT_CEILING_DIRECTORIES: outputDirectory });
}

assert.equal(invocations.length, 3);
const [nativeInvocation, currentInvocation, candidateInvocation] = invocations;
assert.equal(nativeInvocation.command, 'codex');
assert.equal(nativeInvocation.args.includes('--json'), true);
assert.equal(nativeInvocation.args.includes('--ephemeral'), true);
assert.equal(nativeInvocation.args.includes('--ignore-user-config'), true);
assert.equal(nativeInvocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
assert.equal(nativeInvocation.args.includes('--sandbox'), true);
assert.equal(nativeInvocation.args.includes('workspace-write'), true);
assert.equal(nativeInvocation.args.includes('approval_policy="on-request"'), true);
assert.equal(nativeInvocation.args.includes('approvals_reviewer="auto_review"'), true);
assert.equal(nativeInvocation.args.includes('sandbox_workspace_write.network_access=false'), true);
assert.equal(nativeInvocation.args.some((value) => value.includes('mcp_servers.aishell')), false);
assert.equal(currentInvocation.args.some((value) => value.includes(currentBinary)), true);
assert.equal(currentInvocation.args.some((value) => value.includes('phase3-mcp-wire-tap.mjs')), true);
assert.equal(currentInvocation.args.some((value) => value.includes('AISHELL_PHASE3_MCP_WIRE_DIRECTORY')), true);
assert.equal(currentInvocation.args.some((value) => value.includes('AISHELL_TOOL_PROFILE = "development"')), true);
assert.equal(currentInvocation.args.some((value) => value.includes('AISHELL_CAPABILITY_SET')), false);
assert.equal(candidateInvocation.args.some((value) => value.includes(candidateBinary)), true);
assert.equal(candidateInvocation.args.some((value) => value.includes('AISHELL_TOOL_PROFILE = "development"')), true);
assert.equal(candidateInvocation.args.some((value) => value.includes('AISHELL_CAPABILITY_SET = "expanded-v1"')), true);
for (const invocation of invocations) {
  assert.equal(invocation.args.includes(configuration.modelSnapshot), true);
  assert.equal(invocation.args.includes('model_reasoning_effort="high"'), true);
  assert.equal(invocation.args.includes('fixture_host_catalog=true'), true);
  assert.equal(invocation.context.env.RUST_LOG, 'tungstenite::protocol=trace');
  assert.equal(invocation.context.env.GIT_CEILING_DIRECTORIES, outputDirectory);
}
assert.equal(new Set(invocations.map(({ context }) => context.cwd)).size, 3, 'every arm must get a fresh workspace');

timedOut = true;
const timeoutAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-timeout` };
const timeoutRecord = await executor({
  attempt: timeoutAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: await renderRepresentativePrompt(timeoutAttempt.taskID),
});
assert.equal(timeoutRecord.timedOut, true);
assert.equal(timeoutRecord.usage, null, 'timeout must invalidate usage even if a completion event was emitted');
assert.equal(timeoutRecord.providerUsageFormat, 'codex-provider-sse-jsonl.v1');

incompleteSSE = true;
const midResponseTimeoutAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-mid-response-timeout` };
const midResponseTimeoutRecord = await executor({
  attempt: midResponseTimeoutAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: await renderRepresentativePrompt(midResponseTimeoutAttempt.taskID),
});
assert.equal(midResponseTimeoutRecord.timedOut, true);
assert.equal(midResponseTimeoutRecord.usage, null);
assert.equal(midResponseTimeoutRecord.providerUsageFormat, null);
assert.equal(midResponseTimeoutRecord.providerModels, null);
assert.equal(midResponseTimeoutRecord.providerSSE.byteLength > 0, true, 'incomplete raw SSE must be retained');
assert.equal(midResponseTimeoutRecord.agentResult.byteLength, 0);

timedOut = false;
incompleteSSE = false;
omitUsage = true;
const missingUsageAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-missing-usage` };
const missingUsageRecord = await executor({
  attempt: missingUsageAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: await renderRepresentativePrompt(missingUsageAttempt.taskID),
});
assert.equal(missingUsageRecord.usage, null, 'missing provider usage must remain invalid instead of becoming zero');
assert.equal(missingUsageRecord.providerUsageFormat, null);

assert.throws(() => createPhase3CodexExecutor({
  outputDirectory, armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: candidateBinary },
  sandboxConfiguration: configuration.sandbox,
  approvalReviewer: configuration.approvalReviewer,
  commonHostCatalogDigest: configuration.commonHostCatalogDigest, commonCodexArguments: [],
  observeToolCatalog, observeProviderModel, observeAttempt,
}), /setupAttempt callback is required/u);

const changedCandidate = path.join(root, 'changed-candidate');
await writeFile(changedCandidate, 'wrong');
const badExecutor = createPhase3CodexExecutor({
  outputDirectory: path.join(root, 'bad-runs'),
  armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: changedCandidate },
  sandboxConfiguration: configuration.sandbox,
  approvalReviewer: configuration.approvalReviewer,
  commonHostCatalogDigest: configuration.commonHostCatalogDigest,
  commonCodexArguments: [], setupAttempt, observeToolCatalog, observeProviderModel, observeAttempt, runProcess,
});
await assert.rejects(() => badExecutor({
  attempt: selected.candidate, isolation: manifest.isolation,
  armBinding: manifest.armBindings.candidate, prompt: '',
}), /binary digest differs from manifest/u);

const badCatalogExecutor = createPhase3CodexExecutor({
  outputDirectory: path.join(root, 'bad-catalog-runs'),
  armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: candidateBinary },
  sandboxConfiguration: configuration.sandbox,
  approvalReviewer: configuration.approvalReviewer,
  commonHostCatalogDigest: configuration.commonHostCatalogDigest,
  commonCodexArguments: [], setupAttempt,
  observeToolCatalog: async () => digest('observed-wrong-catalog'),
  observeProviderModel, observeAttempt, runProcess,
});
const candidatePrompt = await renderRepresentativePrompt(selected.candidate.taskID);
await assert.rejects(() => badCatalogExecutor({
  attempt: selected.candidate, isolation: manifest.isolation,
  armBinding: manifest.armBindings.candidate,
  prompt: candidatePrompt,
}), /tool catalog digest differs from manifest/u);

const actualModelAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-wrong-actual-model` };
const wrongActualModelExecutor = createPhase3CodexExecutor(executorOptions({
  outputDirectory: path.join(root, 'wrong-actual-model'),
  observeProviderModel: async ({ providerTraceBytes, providerSSEBytes }) => canonicalJSONBytes({
    schema: 'aishell.provider-model-evidence.v3', source: 'codex-provider-sse',
    models: [{ modelSnapshot: 'different-provider-model', responseCount: 1 }], providerTraceSHA256: sha256Hex(providerTraceBytes),
    providerSSETraceSHA256: sha256Hex(providerSSEBytes),
  }),
}));
await assert.rejects(() => wrongActualModelExecutor({
  attempt: actualModelAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: candidatePrompt,
}), /not bound to trusted provider metadata/u);

const missingMetadataAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-missing-model-metadata` };
const missingMetadataExecutor = createPhase3CodexExecutor(executorOptions({
  outputDirectory: path.join(root, 'missing-model-metadata'),
  observeProviderModel: async () => { throw new Error('provider model metadata unavailable'); },
}));
await assert.rejects(() => missingMetadataExecutor({
  attempt: missingMetadataAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: candidatePrompt,
}), /provider model metadata unavailable/u);

const echoAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-requested-echo` };
const requestedEchoExecutor = createPhase3CodexExecutor(executorOptions({
  outputDirectory: path.join(root, 'requested-echo'),
  observeProviderModel: async () => ({ modelSnapshot: configuration.modelSnapshot }),
}));
await assert.rejects(() => requestedEchoExecutor({
  attempt: echoAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: candidatePrompt,
}), /trusted evidence bytes, not a requested-model echo/u);

const unboundEvidenceAttempt = { ...selected.native, attemptID: `${selected.native.attemptID}-unbound-model-evidence` };
const unboundEvidenceExecutor = createPhase3CodexExecutor(executorOptions({
  outputDirectory: path.join(root, 'unbound-model-evidence'),
  observeProviderModel: async ({ providerSSEBytes }) => canonicalJSONBytes({
    schema: 'aishell.provider-model-evidence.v3', source: 'codex-provider-sse',
    models: extractProviderModelsFromSSETrace(providerSSEBytes),
    providerTraceSHA256: digest('different-provider-trace'),
    providerSSETraceSHA256: sha256Hex(providerSSEBytes),
  }),
}));
await assert.rejects(() => unboundEvidenceExecutor({
  attempt: unboundEvidenceAttempt, isolation: manifest.isolation, armBinding: manifest.armBindings.native,
  prompt: candidatePrompt,
}), /not bound to trusted provider metadata/u);

function validCandidateAdapterTrace({ attempt, workspace, preAttemptManifest }) {
  const isRun = attempt.taskID.startsWith('freshness-cache-');
  const tool = isRun ? 'run_check' : 'change_impact';
  const frozenRequest = isRun
    ? { action: 'execute', executable: 'node', arguments: ['check.mjs'], freshness_inputs: ['check.mjs', 'src/value.mjs'] }
    : {
      action: attempt.taskID.startsWith('focused-pipeline-') ? 'recommend' : 'analyze',
      changed_paths: attempt.taskID === 'change-impact-unresolved-edge' ? ['src/dynamic.mjs'] : ['src/a.mjs'],
      providers: ['static-import'],
    };
  const trustedSetupEvidence = isRun ? {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool,
    profileCheck: {
      projectID: 'fixture-project', profileDigest: digest(`profile-${attempt.attemptID}`), checkID: 'test',
      frozenBindingDigest: frozenRunCheckBindingDigest(frozenRequest),
    },
    cache: 'prefer', selection: { binding: 'prepare' },
    executionPolicy: { timeoutMs: 300_000, retentionSeconds: 3_600 },
  } : {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool, root: workspace,
    rootIdentity: `root-${attempt.attemptID}`, workspaceCursor: `ws2:${attempt.attemptID}`,
    pathBindings: frozenRequest.changed_paths.map((changedPath) => preAttemptManifest.files[changedPath]
      ? { path: changedPath, contentSHA256: preAttemptManifest.files[changedPath] }
      : { path: changedPath, expectedAbsent: true }),
    providerIDs: ['static-import'],
    ...(frozenRequest.action === 'recommend'
      ? { projectID: 'fixture-project', profileDigest: digest(`profile-${attempt.attemptID}`) }
      : {}),
  };
  const productionRequest = adaptFrozenCapabilityRequest({ tool, request: frozenRequest, trustedSetupEvidence });
  const preparedCall = {
    tool, action: frozenRequest.action, frozenRequest,
    frozenRequestBytes: canonicalJSONBytes(frozenRequest), productionRequest,
    productionRequestBytes: canonicalJSONBytes(productionRequest),
  };
  const emptyArtifactSHA256 = sha256Hex(Buffer.alloc(0));
  const productionResult = isRun ? {
    schemaVersion: 'aishell.run-check.v2', planDigest: digest(`plan-${attempt.attemptID}`),
    selectionDigest: digest(`selection-${attempt.attemptID}`), requestedCheckIDs: ['test'], plannedCheckIDs: ['test'],
    cacheState: 'hit', processesStarted: 0, publications: [], steps: [], lookupEvidence: [{ status: 'hit' }],
  } : frozenRequest.action === 'analyze' ? {
    schemaVersion: 'aishell.change-impact.v2', operation: 'analyze', coverage: 'partial', freshness: {}, counts: {},
    items: [], returnedBytes: 0, omittedBytes: 0, hasMore: false, continuation: null,
    artifact: { sha256: emptyArtifactSHA256, sizeBytes: 0 },
  } : {
    schema: 'aishell.change-impact.v2', operation: 'recommend',
    executionPolicy: 'explicit_run_check_only', focusedSetID: `focused-${attempt.attemptID}`,
    focusedSetDigest: digest(`focused-${attempt.attemptID}`), expiresAt: '2026-07-22T00:00:00Z',
    freshness: {}, coverage: 'partial', candidateCount: 0, stepCount: 0, limitationCount: 0,
    items: [], byteBudget: 1_048_576, hasMore: false, continuation: null,
    artifact: { sha256: emptyArtifactSHA256, sizeBytes: 0 },
  };
  const productionResultBytes = canonicalJSONBytes(productionResult);
  const rawV2Pages = isRun ? undefined : [{ result: productionResult }];
  const completeArtifactBytes = isRun ? undefined : Buffer.alloc(0);
  const projectedResultBytes = canonicalJSONBytes(projectProductionV2Result({
    tool, frozenRequest, productionResult, rawV2Pages, completeArtifactBytes,
  }));
  const trace = buildBenchmarkTrace({
    v1RequestBytes: preparedCall.frozenRequestBytes, trustedSetupEvidence,
    v2RequestBytes: preparedCall.productionRequestBytes,
    rawV2Pages: [{ result: productionResult, resultBytes: productionResultBytes }],
    completeArtifactBytes: Buffer.alloc(0), projectedV1Bytes: projectedResultBytes,
  });
  return candidateAdapterTraceBytes({
    attemptID: attempt.attemptID, taskID: attempt.taskID, preparedCall,
    benchmarkSetupEvidence: {
      schema: 'aishell.benchmark-setup-evidence.v1', taskId: attempt.taskID,
      workspaceRoot: workspace, preStateDigest: preAttemptManifest.digest,
    },
    trustedSetupEvidence, productionResultBytes, trace, projectedResultBytes,
  });
}

timedOut = false;
omitUsage = false;
const integratedExecutor = createPhase3CodexExecutor({
  outputDirectory: path.join(root, 'integrated-runs'),
  armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: candidateBinary },
  sandboxConfiguration: configuration.sandbox,
  approvalReviewer: configuration.approvalReviewer,
  commonHostCatalogDigest: configuration.commonHostCatalogDigest,
  commonCodexArguments: ['--config', 'fixture_host_catalog=true'],
  setupAttempt: async ({ attempt, workspace, applyFrozenMutation }) => {
    await applyFrozenMutation();
    return { schema: 'fixture-setup.v1', taskID: attempt.taskID, workspace };
  },
  observeToolCatalog, observeProviderModel,
  observeAttempt: async ({ attempt, workspace, preAttemptManifest }) => ({
    observerEvidence: { schema: 'fixture-observer.v1', attemptID: attempt.attemptID },
    adapterTraceBytes: attempt.arm === 'candidate'
      ? validCandidateAdapterTrace({ attempt, workspace, preAttemptManifest })
      : null,
  }),
  runProcess,
});
const integratedResult = await runPhase3Attempts({ manifest, executeAttempt: integratedExecutor });
assert.equal(integratedResult.status, 'valid', JSON.stringify(integratedResult.invalidReasons));
assert.deepEqual(validatePhase3Result(integratedResult, manifest), { valid: true, reasons: [] });
assert.equal(integratedResult.attempts.length, 54);
assert.equal(integratedResult.attempts.every(({ providerUsageFormat }) => providerUsageFormat === 'codex-provider-sse-jsonl.v1'), true);

const wrongFormatAttempts = structuredClone(integratedResult.attempts);
wrongFormatAttempts[0].providerUsageFormat = 'openai-responses-jsonl.v1';
const wrongFormatResult = assemblePhase3Result(manifest, wrongFormatAttempts);
assert.equal(wrongFormatResult.status, 'invalid');
assert.deepEqual(wrongFormatResult.invalidReasons, ['attempt 1 provider usage format mismatch']);

const missingFormatAttempts = structuredClone(integratedResult.attempts);
delete missingFormatAttempts[0].providerUsageFormat;
const missingFormatResult = assemblePhase3Result(manifest, missingFormatAttempts);
assert.equal(missingFormatResult.status, 'invalid');
assert.deepEqual(missingFormatResult.invalidReasons, ['attempt 1 has invalid fields']);

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase3_codex_executor_self_test.v1', invocations: invocations.length,
  integratedAttempts: integratedResult.attempts.length, status: 'valid',
})}\n`);
