#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  aggregatePhase3Acceptance, bindExternalOracleEvaluations,
} from './phase3-acceptance-aggregate.mjs';
import {
  assemblePhase3Result, buildPhase3AttemptManifest, candidateAdapterTraceBytes, exactByteBinding,
  prepareCandidateRequests, recordCandidateProjection,
} from './phase3-representative-runner.mjs';
import {
  adaptFrozenCapabilityRequest, buildBenchmarkTrace, canonicalJSONBytes, frozenRunCheckBindingDigest,
  projectProductionV2Result, sha256Hex,
} from './production-v2-benchmark-adapter.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const configuration = {
  schema: 'aishell.phase3-run-configuration.v1',
  provider: 'fixture-provider',
  modelSnapshot: 'fixture-model-snapshot-2026-07-22',
  reasoningEffort: 'medium',
  sandbox: { approvalPolicy: 'never', filesystem: 'isolated-disposable-workspace', network: false },
  commonHostCatalogDigest: digest('same-common-host-catalog'),
  armBindings: {
    native: { binding: 'frozen native host surface', aishellBinaryDigest: null, aishellToolCatalogDigest: null },
    'current-aishell-0.3.3': {
      binding: 'frozen AIShell 0.3.3 package', aishellBinaryDigest: digest('current-binary'),
      aishellToolCatalogDigest: digest('current-catalog'),
    },
    candidate: {
      binding: 'candidate commit package', aishellBinaryDigest: digest('candidate-binary'),
      aishellToolCatalogDigest: digest('candidate-catalog'),
    },
  },
};
const manifest = await buildPhase3AttemptManifest(configuration);
const tasks = manifest.tasks;
const root = path.resolve('/benchmark-fixture');
const exactProviderTrace = exactByteBinding(Buffer.from(`${JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 },
})}\n`, 'utf8'));
const exactAgentResult = exactByteBinding(Buffer.from('{"schema":"aishell.agent-benchmark-report.v1"}\n', 'utf8'));

const runPreAttempt = {
  schema: 'aishell.workspace-manifest.v1', root, fileCount: 2,
  files: { 'check.mjs': digest('check'), 'src/value.mjs': digest('value') }, digest: digest('run-pre-state'),
};
const runSetupEvidence = {
  schema: 'aishell.benchmark-setup-evidence.v1', taskId: 'freshness-cache-repeat-check', workspaceRoot: root,
  preStateDigest: runPreAttempt.digest, checkpoint: 'chk_fixture', cursor: 'ws2:fixture:generation:2',
  runId: 'run_fixture', handles: ['art_one'],
};
const frozenRunRequest = {
  action: 'execute', executable: 'node', arguments: ['check.mjs'], freshness_inputs: ['check.mjs', 'src/value.mjs'],
};
const trustedRunSetup = {
  schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'run_check',
  profileCheck: {
    projectID: 'fixture-project', profileDigest: digest('profile'), checkID: 'test',
    frozenBindingDigest: frozenRunCheckBindingDigest(frozenRunRequest),
  },
  cache: 'prefer', selection: { binding: 'prepare' },
  executionPolicy: { timeoutMs: 300_000, retentionSeconds: 3_600 },
};
const preparedRun = await prepareCandidateRequests({
  taskId: runSetupEvidence.taskId, workspaceRoot: root, preAttemptManifest: runPreAttempt,
  baselineManifest: runPreAttempt, setupEvidence: runSetupEvidence,
  trustedProductionSetup: { run_check: trustedRunSetup },
});
const productionRunResult = {
  schemaVersion: 'aishell.run-check.v2', planDigest: digest('plan'), selectionDigest: digest('selection'),
  requestedCheckIDs: ['test'], plannedCheckIDs: ['test'], cacheState: 'hit', processesStarted: 0,
  publications: [], steps: [], lookupEvidence: [{ status: 'hit' }],
};
const recordedRun = recordCandidateProjection({
  preparedCall: preparedRun.calls[0], trustedSetupEvidence: trustedRunSetup,
  productionResult: productionRunResult,
  productionResultBytes: Buffer.from(`${JSON.stringify(productionRunResult)}\n`, 'utf8'),
});

function adapterTraceForAttempt(attempt) {
  const benchmarkSetupEvidence = {
    schema: 'aishell.benchmark-setup-evidence.v1', taskId: attempt.taskID,
    workspaceRoot: root, preStateDigest: digest(`pre-${attempt.attemptID}`),
  };
  if (attempt.taskID.startsWith('freshness-cache-')) {
    return exactByteBinding(candidateAdapterTraceBytes({
      attemptID: attempt.attemptID, taskID: attempt.taskID, preparedCall: preparedRun.calls[0],
      benchmarkSetupEvidence, trustedSetupEvidence: trustedRunSetup,
      productionResultBytes: recordedRun.productionResultBytes, trace: recordedRun.trace,
      projectedResultBytes: recordedRun.projectedBytes,
    }));
  }
  const frozenRequest = {
    action: attempt.taskID.startsWith('focused-pipeline-') ? 'recommend' : 'analyze',
    changed_paths: attempt.taskID === 'change-impact-unresolved-edge' ? ['src/dynamic.mjs'] : ['src/a.mjs'],
    providers: ['static-import'],
  };
  const trustedSetupEvidence = {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', root,
    rootIdentity: `root-${attempt.attemptID}`, workspaceCursor: `ws2:${attempt.attemptID}`,
    pathBindings: frozenRequest.changed_paths.map((changedPath) => changedPath === 'src/dynamic.mjs'
      ? { path: changedPath, expectedAbsent: true }
      : { path: changedPath, contentSHA256: digest(`${attempt.attemptID}:${changedPath}`) }),
    providerIDs: ['static-import'],
    ...(frozenRequest.action === 'recommend'
      ? { projectID: 'fixture-project', profileDigest: digest(`profile-${attempt.attemptID}`) } : {}),
  };
  const productionRequest = adaptFrozenCapabilityRequest({
    tool: 'change_impact', request: frozenRequest, trustedSetupEvidence,
  });
  const preparedCall = {
    tool: 'change_impact', action: frozenRequest.action, frozenRequest,
    frozenRequestBytes: canonicalJSONBytes(frozenRequest), productionRequest,
    productionRequestBytes: canonicalJSONBytes(productionRequest),
  };
  const candidateID = digest(`candidate-${attempt.attemptID}`);
  const evidenceID = digest(`evidence-${attempt.attemptID}`);
  const items = frozenRequest.action === 'recommend'
    ? [{
      kind: 'focused_candidate', itemID: 'focused', focusedCheckID: 'focused-1', profileCheckID: 'test',
      profileDigest: trustedSetupEvidence.profileDigest, selector: { kind: 'test_path', path: 'test/a.test.mjs' },
    }]
    : attempt.taskID === 'change-impact-unresolved-edge'
      ? [{ kind: 'coverage_gap', itemID: 'gap', coverageGap: { reasonCode: 'dynamic_import' } }]
      : [
        { kind: 'candidate', itemID: 'candidate', candidateID, category: 'references', subject: { kind: 'path', path: 'src/b.mjs' } },
        { kind: 'evidence', itemID: 'evidence', evidenceID, providerID: 'static-import', inputIdentity: 'src/a.mjs',
          subject: { kind: 'path', path: 'src/b.mjs' }, relation: 'lexical_reference', locator: {},
          evidenceStrength: 'lexical_match', summary: 'fixture import' },
        { kind: 'candidate_evidence', itemID: 'edge', candidateID, evidenceID },
      ];
  const completeArtifactBytes = Buffer.concat(items.map((item) =>
    Buffer.concat([canonicalJSONBytes(item), Buffer.from('\n')])));
  const artifact = {
    handle: `art_${digest(attempt.attemptID).slice(0, 16)}`, kind: 'change-impact-jsonl',
    sizeBytes: completeArtifactBytes.length, lineCount: items.length, sha256: sha256Hex(completeArtifactBytes),
    createdAt: '2026-07-22T00:00:00Z', expiresAt: '2026-07-23T00:00:00Z', producer: 'change_impact',
  };
  const productionResult = frozenRequest.action === 'recommend'
    ? {
      schema: 'aishell.change-impact.v2', operation: 'recommend', executionPolicy: 'explicit_run_check_only',
      focusedSetID: `set_${digest(attempt.attemptID).slice(0, 16)}`, focusedSetDigest: digest(`set-${attempt.attemptID}`),
      expiresAt: '2026-07-23T00:00:00Z', freshness: {}, coverage: 'partial', candidateCount: 1,
      stepCount: 0, limitationCount: 0, items, byteBudget: 1_048_576, hasMore: false, continuation: null, artifact,
    }
    : {
      schemaVersion: 'aishell.change-impact.v2', operation: 'analyze', coverage: 'partial', freshness: {}, counts: {},
      items, returnedBytes: completeArtifactBytes.length, omittedBytes: 0, hasMore: false, continuation: null, artifact,
    };
  const productionResultBytes = Buffer.from(`${JSON.stringify(productionResult)}\n`, 'utf8');
  const projectedResultBytes = canonicalJSONBytes(projectProductionV2Result({
    tool: 'change_impact', frozenRequest, rawV2Pages: [{ result: productionResult }], completeArtifactBytes,
  }));
  const trace = buildBenchmarkTrace({
    v1RequestBytes: preparedCall.frozenRequestBytes, trustedSetupEvidence,
    v2RequestBytes: preparedCall.productionRequestBytes,
    rawV2Pages: [{ result: productionResult, resultBytes: productionResultBytes }],
    completeArtifactBytes, projectedV1Bytes: projectedResultBytes,
  });
  return exactByteBinding(candidateAdapterTraceBytes({
    attemptID: attempt.attemptID, taskID: attempt.taskID, preparedCall, benchmarkSetupEvidence,
    trustedSetupEvidence, productionResultBytes, trace, completeArtifactBytes, projectedResultBytes,
  }));
}

const attempts = manifest.attempts.map((attempt) => ({
  attemptID: attempt.attemptID, sequence: attempt.sequence, taskID: attempt.taskID,
  arm: attempt.arm, repetition: attempt.repetition,
  usage: {
    source: 'provider', inputTokens: 100, cachedInputTokens: 20,
    outputTokens: 30, reasoningOutputTokens: 10, totalModelTokens: 130,
  },
  providerTrace: structuredClone(exactProviderTrace), providerUsageFormat: 'codex-exec-jsonl.v1',
  agentResult: structuredClone(exactAgentResult),
  adapterTrace: attempt.arm === 'candidate' ? adapterTraceForAttempt(attempt) : null,
  agentExitCode: 0, timedOut: false, wallMilliseconds: attempt.sequence * 10,
}));
const result = assemblePhase3Result(manifest, attempts);
assert.equal(result.status, 'valid',
  `fixture result must be produced and accepted by the runner source of truth: ${result.invalidReasons.join('; ')}`);

const oracleRecords = manifest.attempts.map((attempt) => ({
  sequence: attempt.sequence,
  result: {
    schema: 'aishell.capability-oracle-result.v1', taskId: attempt.taskID, arm: attempt.arm,
    solved: true, failures: [],
  },
}));
const observerMetricRecords = manifest.attempts.map((attempt) => ({
  sequence: attempt.sequence,
  metrics: {
    firstUsefulResultMilliseconds: attempt.sequence % 2 === 0 ? attempt.sequence : null,
    toolCalls: 1, modelTurns: 2, retries: 0, artifactRereads: 1,
    filesystemEntriesRescanned: 3, bytesReread: 4, processReexecutions: 0,
    cacheHits: 1, changeJournalHits: 1, toolAdoption: attempt.arm === 'candidate',
  },
}));
const executorEvidenceRecords = manifest.attempts.map((attempt) => ({
  sequence: attempt.sequence, status: 'completed', failure: null,
}));
const evaluations = bindExternalOracleEvaluations({
  manifest, oracleRecords, observerMetricRecords, executorEvidenceRecords,
});
assert.deepEqual(evaluations.map(({ attemptID }) => attemptID),
  [...manifest.attempts].sort((left, right) => left.sequence - right.sequence).map(({ attemptID }) => attemptID));
const aggregate = (overrides = {}) => aggregatePhase3Acceptance({
  manifest, result, oracleRecords, observerMetricRecords, executorEvidenceRecords, ...overrides,
});

const report = aggregate();
assert.equal(report.status, 'valid');
assert.equal(report.overallArms.length, 3);
assert.equal(report.perTaskArms.length, 18);
assert.equal(report.correctnessGate.passed, true);
assert.deepEqual(report.correctnessGate.nativeSolvedTasks, tasks);
const native = report.overallArms.find(({ arm }) => arm === 'native');
assert.equal(native.attempts, 18);
assert.equal(native.solvedAttempts, 18);
assert.equal(native.solvedTasks, 6);
assert.equal(native.totals.toolCalls, 18);
assert.deepEqual(native.tokensPerSolvedAttempt, {
  state: 'finite',
  value: attempts.filter(({ arm }) => arm === 'native').reduce((sum, item) => sum + item.usage.totalModelTokens, 0) / 18,
});
assert.deepEqual(report.overallArms.find(({ arm }) => arm === 'candidate').toolAdoption, { attempts: 18, rate: 1 });
assert.equal(JSON.stringify(report).includes('evaluationSource'), false, 'per-attempt oracle evidence must not leak into the report');

const failedOracles = structuredClone(oracleRecords);
for (const record of failedOracles) {
  if (record.result.arm === 'candidate') {
    record.result.solved = false;
    record.result.failures = ['fixture oracle failure'];
  }
}
const failedReport = aggregate({ oracleRecords: failedOracles });
const candidate = failedReport.overallArms.find(({ arm }) => arm === 'candidate');
assert.equal(candidate.solvedAttempts, 0);
assert.equal(candidate.totalModelTokens,
  attempts.filter(({ arm }) => arm === 'candidate').reduce((sum, item) => sum + item.usage.totalModelTokens, 0),
  'failed valid attempts remain in the token numerator');
assert.deepEqual(candidate.tokensPerSolvedAttempt, { state: 'positive_infinity', value: null });
assert.deepEqual(failedReport.correctnessGate.candidateRegressionsFromNative, tasks);

const oneFailedOracles = structuredClone(oracleRecords);
const failedAttempt = manifest.attempts.find(({ taskID, arm, repetition }) =>
  taskID === tasks[0] && arm === 'current-aishell-0.3.3' && repetition === 2);
const failedOracle = oneFailedOracles.find(({ sequence }) => sequence === failedAttempt.sequence).result;
failedOracle.solved = false;
failedOracle.failures = ['fixture oracle failure'];
const oneFailedReport = aggregate({ oracleRecords: oneFailedOracles });
assert.equal(oneFailedReport.perTaskArms.find(({ taskID, arm }) =>
  taskID === tasks[0] && arm === 'current-aishell-0.3.3').taskSolved, false);
assert.deepEqual(oneFailedReport.correctnessGate.currentRegressionsFromNative, [tasks[0]]);

const missingUsage = structuredClone(result);
missingUsage.attempts[0].usage = null;
assert.match(aggregate({ result: missingUsage }).invalidReasons[0], /runner validation/u);

const failedExecutor = structuredClone(executorEvidenceRecords);
failedExecutor[0] = { sequence: failedExecutor[0].sequence, status: 'failed', failure: 'executor crashed' };
const harnessEvaluations = bindExternalOracleEvaluations({
  manifest, oracleRecords, observerMetricRecords, executorEvidenceRecords: failedExecutor,
});
assert.equal(harnessEvaluations[0].harnessSucceeded, false);
assert.match(aggregate({ executorEvidenceRecords: failedExecutor }).invalidReasons[0], /harness failure/u);

const duplicateOracle = structuredClone(oracleRecords);
duplicateOracle[53].sequence = duplicateOracle[0].sequence;
assert.throws(() => bindExternalOracleEvaluations({
  manifest, oracleRecords: duplicateOracle, observerMetricRecords, executorEvidenceRecords,
}), /duplicate sequence/u);
assert.throws(() => bindExternalOracleEvaluations({
  manifest, oracleRecords: oracleRecords.slice(0, -1), observerMetricRecords, executorEvidenceRecords,
}), /exactly 54/u);
const incompatibleOracle = structuredClone(oracleRecords);
incompatibleOracle[0].result.taskId = tasks[1];
assert.throws(() => bindExternalOracleEvaluations({
  manifest, oracleRecords: incompatibleOracle, observerMetricRecords, executorEvidenceRecords,
}), /incompatible/u);
const extraOracleField = structuredClone(oracleRecords);
extraOracleField[0].result.attemptID = 'fabricated';
assert.throws(() => bindExternalOracleEvaluations({
  manifest, oracleRecords: extraOracleField, observerMetricRecords, executorEvidenceRecords,
}), /invalid fields/u);
const extraMetricField = structuredClone(observerMetricRecords);
extraMetricField[0].attemptID = 'fabricated';
assert.throws(() => bindExternalOracleEvaluations({
  manifest, oracleRecords, observerMetricRecords: extraMetricField, executorEvidenceRecords,
}), /invalid fields/u);
assert.throws(() => bindExternalOracleEvaluations({
  manifest, oracleRecords, observerMetricRecords, executorEvidenceRecords: executorEvidenceRecords.slice(0, -1),
}), /exactly 54/u);

const fabricated = structuredClone(result);
fabricated.manifestSHA256 = 'f'.repeat(64);
assert.match(aggregate({ result: fabricated }).invalidReasons[0], /runner validation/u);
const replacement = structuredClone(oracleRecords);
replacement[0].replacementFor = 'discarded-attempt';
assert.match(aggregate({ oracleRecords: replacement }).invalidReasons[0], /invalid fields/u);

const schema = JSON.parse(await readFile(new URL('./phase3-acceptance-report.schema.json', import.meta.url), 'utf8'));
assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(schema.properties.replacementPolicy.const, 'forbidden');
assert.equal(schema.properties.overallArms.oneOf[1].minItems, 3);
assert.equal(schema.properties.perTaskArms.oneOf[1].minItems, 18);
assert.deepEqual(schema.$defs.tokensPerSolvedAttempt.oneOf[1].properties.value, { type: 'null' });

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase3-acceptance-aggregate-self-test.v1', attempts: attempts.length, status: 'valid',
})}\n`);
