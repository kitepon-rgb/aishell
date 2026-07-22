#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureManifest } from './capture-workspace-manifest.mjs';
import {
  createPhase3ProductionHarness,
  mcpCatalogRequestBytes,
  validateCatalogExchange,
} from './phase3-production-harness.mjs';
import {
  candidateAdapterTraceBytes,
  buildPhase3AttemptManifest,
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

const root = await mkdtemp(path.join(tmpdir(), 'aishell-phase3-production-harness-'));
const workspace = path.join(root, 'workspace');
const stateDirectory = path.join(root, 'state');
const runDirectory = path.join(root, 'run');
const artifactStore = path.join(root, 'artifacts');
await Promise.all([workspace, stateDirectory, runDirectory, artifactStore].map((directory) => mkdir(directory)));
await mkdir(path.join(workspace, 'src'));
await writeFile(path.join(workspace, 'check.mjs'), "import { value } from './src/value.mjs';\n");
await writeFile(path.join(workspace, 'src/value.mjs'), 'export const value = 1;\n');
const baselineManifest = await captureManifest(workspace);

const setupCalls = [];
const exchangeCalls = [];
const collectionCalls = [];
const attempt = {
  attemptID: 'phase3-fixture-freshness-cache-input-change-native-r1',
  sequence: 1,
  taskID: 'freshness-cache-input-change',
  arm: 'native',
  repetition: 1,
};
const frozen = {
  task: { id: attempt.taskID, fixture: 'freshness-cache', scenario: 'input-change' },
  fixture: { id: 'freshness-cache', seedFiles: {
    'check.mjs': "import { value } from './src/value.mjs';\n",
    'src/value.mjs': 'export const value = 1;\n',
  } },
  mutation: [{ op: 'write', path: 'src/value.mjs', content: 'export const value = 2;\n' }],
  contract: {
    taskId: attempt.taskID,
    setupSteps: ['materialize fixture', 'execute the check once and retain its freshness inputs', 'apply the frozen source mutation'],
    timedSteps: ['submit the frozen repeat prompt', 'record process executions and cache evidence'],
  },
};

function catalogResponseBytes() {
  return Buffer.from([
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }),
    JSON.stringify({ result: { tools: [{ name: 'run_check', inputSchema: { type: 'object' } }] }, id: 2, jsonrpc: '2.0' }),
  ].join('\n') + '\n');
}

const metrics = {
  firstUsefulResultMilliseconds: 5,
  toolCalls: 0,
  modelTurns: 1,
  retries: 0,
  artifactRereads: 0,
  filesystemEntriesRescanned: 0,
  bytesReread: 0,
  processReexecutions: 1,
  cacheHits: 0,
  changeJournalHits: 0,
  toolAdoption: false,
};

const callbacks = {
  runSetupStep: async (input) => {
    setupCalls.push(input);
    assert.equal(input.step, 'execute the check once and retain its freshness inputs');
    assert.equal(JSON.stringify(input).includes('oracle'), false);
    return { schema: 'fixture-check-setup.v1', processCount: 1 };
  },
  captureTrustedSetup: async (input) => {
    assert.equal(JSON.stringify(input).includes('oracle'), false);
    assert.equal(input.stepEvidence.length, 3);
    return { run_check: { schema: 'fixture-trusted-run-check.v1' } };
  },
  exchangeMCP: async (input) => {
    exchangeCalls.push(input);
    assert.equal(input.requestBytes.equals(mcpCatalogRequestBytes()), true);
    return catalogResponseBytes();
  },
  collectAttemptEvidence: async (input) => {
    collectionCalls.push(input);
    assert.equal(JSON.stringify(input).includes('oracle'), false);
    assert.equal(input.trustedProductionSetup.run_check.schema, 'fixture-trusted-run-check.v1');
    return {
      result: {},
      process: {},
      artifactStore,
      telemetry: { secondExecutionCount: 1, cacheHit: false, falseFresh: 0 },
      trace: {},
      toolTrace: { events: [] },
      metrics,
      adapterTraceBytes: null,
    };
  },
  observeProviderModel: async ({ providerTraceBytes, providerSSEBytes }) => {
    const events = providerTraceBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    const metadata = events.filter((event) => event.type === 'provider.metadata');
    if (metadata.length !== 1) throw new Error('fixture provider metadata unavailable');
    return canonicalJSONBytes({
      schema: 'aishell.provider-model-evidence.v1', source: 'codex-provider-sse',
      modelSnapshot: metadata[0].model_snapshot, providerTraceSHA256: sha256Hex(providerTraceBytes),
      providerSSETraceSHA256: sha256Hex(providerSSEBytes),
    });
  },
  runProcess: async () => { throw new Error('external model process must not run in this test'); },
};

const harness = createPhase3ProductionHarness({ executorOptions: {}, ...callbacks });
let mutationCount = 0;
const setup = await harness.callbacks.setupAttempt({
  attempt,
  armBinding: { binding: 'native', aishellBinaryDigest: null, aishellToolCatalogDigest: null },
  workspace,
  stateDirectory,
  frozen,
  baselineManifest,
  applyFrozenMutation: async () => {
    mutationCount += 1;
    assert.equal(mutationCount, 1);
    await writeFile(path.join(workspace, 'src/value.mjs'), 'export const value = 2;\n');
  },
});
assert.equal(mutationCount, 1);
assert.equal(setupCalls.length, 1);
assert.deepEqual(Object.keys(setup).sort(), ['preStateDigest', 'schema', 'taskId', 'workspaceRoot']);
assert.equal(setup.preStateDigest, (await captureManifest(workspace)).digest);
assert.equal(await readFile(path.join(workspace, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
await assert.rejects(() => harness.callbacks.setupAttempt({
  attempt, workspace, stateDirectory, frozen, baselineManifest, applyFrozenMutation: async () => {},
}), /setup attempt repeated/u);

const responseBytes = catalogResponseBytes();
const directObservation = validateCatalogExchange(mcpCatalogRequestBytes(), responseBytes);
assert.equal(directObservation.responseSHA256, sha256Hex(responseBytes));
const catalogDigest = await harness.callbacks.observeToolCatalog({
  binary: path.join(root, 'fake-aishell'), profile: 'expanded-v1', stateDirectory, workspace,
});
assert.equal(catalogDigest, sha256Hex(responseBytes));
assert.equal(exchangeCalls.length, 1);
assert.equal((await readFile(path.join(stateDirectory, 'benchmark-mcp-catalog-request.jsonl'))).equals(mcpCatalogRequestBytes()), true);
assert.equal((await readFile(path.join(stateDirectory, 'benchmark-mcp-catalog-response.jsonl'))).equals(responseBytes), true);
assert.throws(() => validateCatalogExchange(Buffer.from('{}\n'), responseBytes), /request bytes differ/u);
assert.throws(() => validateCatalogExchange(mcpCatalogRequestBytes(), Buffer.from('{\n')), /not a JSON object/u);

await writeFile(path.join(runDirectory, 'baseline-manifest.json'), `${JSON.stringify(baselineManifest)}\n`);
const preAttemptManifest = await captureManifest(workspace);
await writeFile(path.join(runDirectory, 'pre-attempt-manifest.json'), `${JSON.stringify(preAttemptManifest)}\n`);
await writeFile(path.join(runDirectory, 'setup-evidence.json'), `${JSON.stringify(setup)}\n`);
const finalAgent = { schema: 'aishell.agent-benchmark-report.v1', taskId: attempt.taskID, assertions: {} };
const observed = await harness.callbacks.observeAttempt({
  attempt,
  workspace,
  stateDirectory,
  runDirectory,
  baselineManifest,
  preAttemptManifest,
  setup,
  events: [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(finalAgent) } }],
  toolTrace: { schema: 'aishell.phase3-codex-tool-trace.v1', events: [] },
  finalAgent,
  execution: { exitCode: 0, timedOut: false, wallMilliseconds: 10 },
});
assert.equal(observed.observerEvidence.producer, 'aishell-benchmark-observer.v1');
assert.equal(collectionCalls.length, 1);
assert.equal(observed.adapterTraceBytes, null);
assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'observer-request-contract.json'))).taskId, attempt.taskID);

const providerTrace = Buffer.from([
  JSON.stringify({ type: 'provider.metadata', model_snapshot: 'fixture-model' }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
].join('\n') + '\n');
const providerSSE = Buffer.from('fixture SSE');
const modelEvidenceBytes = await harness.callbacks.observeProviderModel({ providerTraceBytes: providerTrace, providerSSEBytes: providerSSE });
assert.deepEqual(JSON.parse(modelEvidenceBytes), {
  schema: 'aishell.provider-model-evidence.v1', source: 'codex-provider-sse',
  modelSnapshot: 'fixture-model', providerTraceSHA256: sha256Hex(providerTrace),
  providerSSETraceSHA256: sha256Hex(providerSSE),
});

for (const missing of ['runSetupStep', 'captureTrustedSetup', 'exchangeMCP', 'collectAttemptEvidence', 'observeProviderModel', 'runProcess']) {
  const incomplete = { executorOptions: {}, ...callbacks };
  delete incomplete[missing];
  assert.throws(() => createPhase3ProductionHarness(incomplete), new RegExp(`${missing} callback is required`, 'u'));
}

assert.equal(canonicalJSONBytes(setup).includes(Buffer.from('oracle')), false);

// Full 54-attempt integration: fake provider/process evidence only. This exercises the real
// runner, executor, observer, oracle conversion, and aggregator boundary through harness.run().
const integrationRoot = await mkdtemp(path.join(tmpdir(), 'aishell-phase3-production-integration-'));
const integrationOutput = path.join(integrationRoot, 'runs');
const integrationArtifacts = path.join(integrationRoot, 'artifacts');
const currentBinary = path.join(integrationRoot, 'current-aishell');
const candidateBinary = path.join(integrationRoot, 'candidate-aishell');
await mkdir(integrationArtifacts);
await writeFile(currentBinary, 'current fixture binary');
await writeFile(candidateBinary, 'candidate fixture binary');
const integrationCatalogBytes = catalogResponseBytes();
const catalogSHA256 = sha256Hex(integrationCatalogBytes);
const integrationConfiguration = {
  schema: 'aishell.phase3-run-configuration.v1',
  provider: 'fixture-provider',
  modelSnapshot: 'fixture-model',
  reasoningEffort: 'high',
  sandbox: { approvalPolicy: 'never', filesystem: 'workspace-write', network: false },
  commonHostCatalogDigest: sha256Hex('fixture-host-catalog'),
  armBindings: {
    native: { binding: 'native fixture', aishellBinaryDigest: null, aishellToolCatalogDigest: null },
    'current-aishell-0.3.3': {
      binding: 'current fixture', aishellBinaryDigest: sha256Hex(await readFile(currentBinary)),
      aishellToolCatalogDigest: catalogSHA256,
    },
    candidate: {
      binding: 'candidate fixture', aishellBinaryDigest: sha256Hex(await readFile(candidateBinary)),
      aishellToolCatalogDigest: catalogSHA256,
    },
  },
};
const integrationManifest = await buildPhase3AttemptManifest(integrationConfiguration);
const attemptsByID = new Map(integrationManifest.attempts.map((item) => [item.attemptID, item]));
const functionalAssertions = (taskID) => {
  if (taskID === 'change-impact-direct-dependent') return { impactedPaths: [], provenanceRequired: false };
  if (taskID === 'change-impact-unresolved-edge') return { unknowns: 0, silentCompletenessClaims: 0 };
  if (taskID === 'focused-pipeline-recommend-only') return { recommendedChecks: [], executedChecks: 0 };
  if (taskID === 'focused-pipeline-explicit-run') return { recommendedChecks: [], executionRequiresOptIn: false };
  return {};
};

async function integrationTrustedSetup({ attempt: item, workspace: attemptWorkspace }) {
  const isRun = item.taskID.startsWith('freshness-cache-');
  if (isRun) {
    const frozenRequest = {
      action: 'execute', executable: 'node', arguments: ['check.mjs'],
      freshness_inputs: ['check.mjs', 'src/value.mjs'],
    };
    return { run_check: {
      schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'run_check',
      profileCheck: {
        projectID: 'fixture-project', profileDigest: sha256Hex(`profile:${item.taskID}`), checkID: 'test',
        frozenBindingDigest: frozenRunCheckBindingDigest(frozenRequest),
      },
      cache: 'prefer', selection: { binding: 'prepare' },
      executionPolicy: { timeoutMs: 300_000, retentionSeconds: 3_600 },
    } };
  }
  const changedPath = item.taskID === 'change-impact-unresolved-edge' ? 'src/dynamic.mjs' : 'src/a.mjs';
  const current = await captureManifest(attemptWorkspace);
  return { change_impact: {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', root: attemptWorkspace,
    rootIdentity: `root:${item.attemptID}`, workspaceCursor: `ws2:${item.attemptID}`,
    pathBindings: [current.files[changedPath]
      ? { path: changedPath, contentSHA256: current.files[changedPath] }
      : { path: changedPath, expectedAbsent: true }],
    providerIDs: ['static-import'],
    ...(item.taskID.startsWith('focused-pipeline-')
      ? { projectID: 'fixture-project', profileDigest: sha256Hex(`profile:${item.taskID}`) }
      : {}),
  } };
}

function productionFixture(preparedCall) {
  if (preparedCall.tool === 'run_check') {
    const result = {
      schemaVersion: 'aishell.run-check.v2', planDigest: sha256Hex('plan'), selectionDigest: sha256Hex('selection'),
      requestedCheckIDs: ['test'], plannedCheckIDs: ['test'], cacheState: 'hit', processesStarted: 0,
      publications: 0, steps: [], lookupEvidence: [{ stepID: 'test', status: 'hit', ineligibilityReason: null }],
    };
    return { result, resultBytes: canonicalJSONBytes(result), rawV2Pages: undefined, artifact: Buffer.alloc(0) };
  }
  const artifact = Buffer.alloc(0);
  const descriptor = {
    handle: 'art_fixture', kind: 'change-impact-jsonl', sizeBytes: 0, lineCount: 0,
    sha256: sha256Hex(artifact), createdAt: '2026-07-22T00:00:00Z', expiresAt: '2026-07-23T00:00:00Z',
    producer: 'change_impact',
  };
  const recommend = preparedCall.action === 'recommend';
  const result = recommend ? {
    schema: 'aishell.change-impact.v2', operation: 'recommend', executionPolicy: 'explicit_run_check_only',
    focusedSetID: 'set_fixture', focusedSetDigest: sha256Hex('set'), expiresAt: '2026-07-23T00:00:00Z',
    freshness: {}, coverage: 'partial', candidateCount: 0, stepCount: 0, limitationCount: 0,
    items: [], byteBudget: 1_048_576, hasMore: false, continuation: null, artifact: descriptor,
  } : {
    schemaVersion: 'aishell.change-impact.v2', operation: 'analyze', coverage: 'partial', freshness: {}, counts: {},
    items: [], returnedBytes: 0, omittedBytes: 0, hasMore: false, continuation: null, artifact: descriptor,
  };
  const resultBytes = canonicalJSONBytes(result);
  return { result, resultBytes, rawV2Pages: [{ result, resultBytes }], artifact };
}

let integrationProcesses = 0;
const integrationHarness = createPhase3ProductionHarness({
  executorOptions: {
    outputDirectory: integrationOutput,
    armBinaries: { 'current-aishell-0.3.3': currentBinary, candidate: candidateBinary },
    sandboxConfiguration: integrationConfiguration.sandbox,
    commonHostCatalogDigest: integrationConfiguration.commonHostCatalogDigest,
    commonCodexArguments: [],
    timeoutMilliseconds: 30_000,
  },
  runSetupStep: async () => ({ schema: 'fixture-setup-step.v1' }),
  captureTrustedSetup: integrationTrustedSetup,
  exchangeMCP: async () => integrationCatalogBytes,
  observeProviderModel: callbacks.observeProviderModel,
  runProcess: async (_command, _args, context) => {
    integrationProcesses += 1;
    const attemptID = path.basename(path.dirname(context.cwd));
    const item = attemptsByID.get(attemptID);
    assert.ok(item, `unknown fake process workspace: ${context.cwd}`);
    const report = { schema: 'aishell.agent-benchmark-report.v1', taskId: item.taskID, assertions: functionalAssertions(item.taskID) };
    const events = [
      { type: 'provider.metadata', model_snapshot: integrationConfiguration.modelSnapshot },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 } },
    ];
    return { stdout: Buffer.from(`${events.map(JSON.stringify).join('\n')}\n`), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false };
  },
  collectAttemptEvidence: async (input) => {
    let adapterTraceBytes = null;
    let projected = {};
    if (input.attempt.arm === 'candidate') {
      const prepared = await prepareCandidateRequests({
        taskId: input.attempt.taskID, workspaceRoot: input.workspace,
        preAttemptManifest: input.preAttemptManifest, baselineManifest: input.baselineManifest,
        setupEvidence: input.benchmarkSetupEvidence, trustedProductionSetup: input.trustedProductionSetup,
      });
      const preparedCall = prepared.calls[0];
      const fixture = productionFixture(preparedCall);
      const trustedSetupEvidence = input.trustedProductionSetup[preparedCall.tool];
      const recorded = preparedCall.tool === 'run_check'
        ? recordCandidateProjection({
          preparedCall,
          trustedSetupEvidence,
          productionResult: fixture.result,
          productionResultBytes: fixture.resultBytes,
        })
        : (() => {
          const projectedResult = projectProductionV2Result({
            tool: preparedCall.tool,
            frozenRequest: preparedCall.frozenRequest,
            rawV2Pages: fixture.rawV2Pages.map(({ result }, index) => ({
              ...(index === 0 ? {} : { requestToken: fixture.rawV2Pages[index].requestToken }), result,
            })),
            completeArtifactBytes: fixture.artifact,
          });
          const projectedBytes = canonicalJSONBytes(projectedResult);
          return {
            projected: projectedResult,
            projectedBytes,
            productionResultBytes: fixture.resultBytes,
            trace: buildBenchmarkTrace({
              v1RequestBytes: preparedCall.frozenRequestBytes,
              trustedSetupEvidence,
              v2RequestBytes: preparedCall.productionRequestBytes,
              rawV2Pages: fixture.rawV2Pages,
              completeArtifactBytes: fixture.artifact,
              projectedV1Bytes: projectedBytes,
            }),
          };
        })();
      projected = recorded.projected;
      adapterTraceBytes = candidateAdapterTraceBytes({
        attemptID: input.attempt.attemptID, taskID: input.attempt.taskID, preparedCall,
        benchmarkSetupEvidence: input.benchmarkSetupEvidence,
        trustedSetupEvidence: input.trustedProductionSetup[preparedCall.tool],
        productionResultBytes: recorded.productionResultBytes,
        trace: recorded.trace,
        completeArtifactBytes: fixture.artifact,
        projectedResultBytes: recorded.projectedBytes,
      });
    }
    return {
      result: projected,
      process: {},
      artifactStore: integrationArtifacts,
      telemetry: {},
      trace: {},
      toolTrace: { events: [] },
      metrics: { ...metrics, toolAdoption: input.attempt.arm === 'candidate' },
      adapterTraceBytes,
    };
  },
});
const integrationOutcome = await integrationHarness.run({ manifest: integrationManifest });
assert.equal(integrationProcesses, 54);
assert.equal(integrationOutcome.result.status, 'valid');
assert.equal(integrationOutcome.result.attempts.length, 54);
assert.equal(integrationOutcome.oracleRecords.length, 54);
assert.equal(integrationOutcome.observerMetricRecords.length, 54);
assert.equal(integrationOutcome.executorEvidenceRecords.length, 54);
assert.equal(integrationOutcome.report.status, 'valid');
assert.equal(integrationOutcome.report.overallArms.length, 3);
assert.equal(Object.hasOwn(integrationOutcome, 'evaluations'), false);

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase3_production_harness_self_test.v1', setupSteps: setupCalls.length,
  catalogExchanges: exchangeCalls.length, observations: collectionCalls.length,
  integratedAttempts: integrationOutcome.result.attempts.length, status: 'valid',
})}\n`);
